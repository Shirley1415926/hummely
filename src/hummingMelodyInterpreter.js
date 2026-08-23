import {
  HUMMING_INTERPRETER_MODES,
  HUMMING_INTERPRETER_VERSION,
  VOICE_RECOGNITION_CONFIG
} from "./voiceRecognitionConfig.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function midiToPitchName(midi) {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function cloneEvent(event, index) {
  const startTime = Math.max(0, Number(event.startTime) || 0);
  const duration = Math.max(0, Number(event.duration) || ((Number(event.endTime) || startTime) - startTime));
  const midi = Number.isFinite(event.midi) ? Math.round(event.midi) : Math.round(event.pitchMidi);
  return {
    ...event,
    id: event.id || `event-${index + 1}`,
    midi,
    pitchName: event.pitchName || midiToPitchName(midi),
    frequency: Number.isFinite(event.frequency) ? event.frequency : midiToFrequency(midi),
    startTime,
    endTime: Math.max(startTime, Number(event.endTime) || startTime + duration),
    duration,
    amplitude: Number.isFinite(event.amplitude) ? event.amplitude : 0,
    onsetConfidence: Number.isFinite(event.onsetConfidence) ? event.onsetConfidence : 0,
    preEnergy: Number.isFinite(event.preEnergy) ? event.preEnergy : 0,
    attackEnergy: Number.isFinite(event.attackEnergy) ? event.attackEnergy : 0,
    energyRise: Number.isFinite(event.energyRise) ? event.energyRise : 0,
    articulationOnsetScore: Number.isFinite(event.articulationOnsetScore) ? event.articulationOnsetScore : 0,
    articulationEvidence: event.articulationEvidence || null,
    sourceBasicPitchEventId: event.sourceBasicPitchEventId || event.id || null,
    processing: { status: "raw", reason: null, mergedInto: null }
  };
}

function mark(event, status, reason, mergedInto = null) {
  event.processing = { status, reason, mergedInto };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedMedian(items, getValue, getWeight) {
  const sorted = items
    .map((item) => ({ value: getValue(item), weight: Math.max(0.0001, getWeight(item)) }))
    .sort((left, right) => left.value - right.value);
  const threshold = sorted.reduce((total, item) => total + item.weight, 0) / 2;
  let total = 0;
  for (const item of sorted) {
    total += item.weight;
    if (total >= threshold) return item.value;
  }
  return sorted[sorted.length - 1]?.value || 0;
}

function eventScore(event, previousEvent) {
  const continuityPenalty = previousEvent ? Math.min(2, Math.abs(event.midi - previousEvent.midi)) * 0.045 : 0;
  return event.amplitude * 0.72 + Math.min(event.duration, 0.8) * 0.2 + event.onsetConfidence * 0.18 - continuityPenalty;
}

function hasReliableReattack(event, config) {
  const { voice } = config;
  return event.onsetConfidence >= voice.reliableOnsetThreshold ||
    (event.energyRise >= voice.energyReattackRatio && event.preEnergy <= event.attackEnergy * voice.energyValleyRatio);
}

function hasArticulationReattack(previous, event, config) {
  const { voice } = config;
  const evidence = event.articulationEvidence || {};
  // A clustered initial onset describes the first syllable's own consonant and
  // vowel transition. It is not evidence that a second note began.
  if (evidence.canSplitStableNote === false || evidence.isIndependentReattack === false) return false;
  const score = Number(event.articulationOnsetScore) || 0;
  const hasAttackEvidence = Number(evidence.basicPitchOnset) >= config.articulation.minimumBasicPitchOnset ||
    (Number(evidence.energyRise) >= config.articulation.minimumEnergyRise && Number(evidence.spectralFlux) >= config.articulation.minimumFluxRatio);
  const hasIndependentEvidence = evidence.canSplitStableNote === true || evidence.isIndependentReattack === true ||
    evidence.independentEnergyReset === true || evidence.modelTransient === true;
  const isStrongEnough = score >= voice.articulationSplitScore ||
    (score >= voice.articulationReliableOnsetScore && hasReliableReattack(event, config));
  const isNotTerminalDecay = event.duration >= voice.fastArticulationMinimumSegmentSeconds &&
    (event.amplitude >= previous.amplitude * 0.42 || hasAttackEvidence);
  return hasIndependentEvidence && isStrongEnough && hasAttackEvidence && isNotTerminalDecay;
}


function hasModelSyllableReattack(previous, event, config) {
  const evidence = event.articulationEvidence || null;
  // A model onset may represent a vibrato fragment or model duplicate. It can
  // help only when raw audio already clustered a separate, independent action.
  if (!evidence?.canSplitStableNote || !evidence?.isIndependentReattack) return false;
  const onsetGap = event.startTime - previous.startTime;
  return event.onsetConfidence >= config.voice.modelReattackMinimumOnset &&
    onsetGap >= config.voice.modelReattackMinimumIntervalSeconds &&
    event.duration >= config.voice.fastArticulationMinimumSegmentSeconds;
}

function isFastDistinctPitch(previous, event, nextEvent, mode) {
  const pitchDelta = Math.abs(previous.midi - event.midi);
  if (pitchDelta < mode.minimumDistinctPitchSemitones || event.duration < mode.minimumFastPitchSeconds) return false;
  const hasIndependentSupport = event.onsetConfidence >= mode.fastPitchOnsetThreshold ||
    event.articulationOnsetScore >= mode.fastPitchArticulationScore;
  const returnsToPitch = nextEvent && nextEvent.midi === previous.midi &&
    nextEvent.startTime - event.endTime <= mode.fastRunWindowSeconds;
  const continuesMelody = nextEvent && Math.abs(nextEvent.midi - event.midi) >= mode.minimumDistinctPitchSemitones &&
    nextEvent.startTime - event.endTime <= mode.fastRunWindowSeconds;
  return hasIndependentSupport || (event.duration >= mode.minimumStablePitchSeconds && (returnsToPitch || continuesMelody));
}

function selectMonophonicEvents(rawEvents, config) {
  const { voice } = config;
  const usable = rawEvents.filter((event) => {
    if (event.midi < voice.minimumMidi || event.midi > voice.maximumMidi) {
      mark(event, "discarded", "outside-voice-range");
      return false;
    }
    if (event.duration < voice.minimumDurationSeconds) {
      mark(event, "discarded", "too-short");
      return false;
    }
    return true;
  });
  const amplitudes = usable.map((event) => event.amplitude).sort((left, right) => left - right);
  const amplitudeFloor = Math.max(
    voice.minimumAmplitude,
    (amplitudes[Math.floor(amplitudes.length / 2)] || 0) * voice.relativeAmplitudeFloor
  );
  const candidates = usable
    .filter((event) => {
      if (event.amplitude < amplitudeFloor) {
        mark(event, "discarded", "low-amplitude");
        return false;
      }
      return true;
    })
    .sort((left, right) => left.startTime - right.startTime || right.amplitude - left.amplitude);

  const selected = [];
  candidates.forEach((event) => {
    const lastIndex = selected.length - 1;
    const previous = selected[lastIndex];
    const overlap = previous ? previous.endTime - event.startTime : 0;
    if (!previous || overlap <= voice.maximumVoiceOverlapSeconds) {
      mark(event, "monophonic", "primary-voice-event");
      selected.push(event);
      return;
    }
    const beforePrevious = selected[lastIndex - 1];
    if (eventScore(event, beforePrevious) > eventScore(previous, beforePrevious)) {
      mark(previous, "discarded", "overlapping-secondary-event");
      mark(event, "monophonic", "replaced-overlapping-secondary-event");
      selected[lastIndex] = event;
    } else {
      mark(event, "discarded", "overlapping-secondary-event");
    }
  });
  return selected;
}

function isClearPause(previous, event, mode, config) {
  const gap = event.startTime - previous.endTime;
  return gap > Math.max(mode.maximumMergeGapSeconds, config.voice.phraseBreakMinimumSeconds);
}

function hasEnergyReattack(event, config) {
  const { voice } = config;
  return event.preEnergy > 0 && event.attackEnergy > 0 &&
    event.preEnergy <= event.attackEnergy * voice.energyValleyRatio &&
    event.energyRise >= voice.energyReattackRatio;
}

function shouldKeepAsNewNote(previous, event, nextEvent, audioDuration, config, mode) {
  const pitchDelta = Math.abs(previous.midi - event.midi);
  const gap = Math.max(0, event.startTime - previous.endTime);
  const clearEnergyReattack = hasEnergyReattack(event, config) && gap >= config.voice.maximumMergeGapSeconds;
  const clearOnsetAfterBreath = event.onsetConfidence >= config.voice.reliableOnsetThreshold &&
    gap >= config.voice.explicitReattackRequiresGapSeconds;
  // A consonant/new syllable may restart the exact same pitch without silence.
  if (pitchDelta === 0 && hasArticulationReattack(previous, event, config)) return "articulation-reattack";
  if (pitchDelta === 0 && hasModelSyllableReattack(previous, event, config)) return "basic-pitch-syllable-onset";
  if (pitchDelta === 0 && (clearEnergyReattack || clearOnsetAfterBreath)) return "reliable-reattack";
  if (isClearPause(previous, event, mode, config)) return "clear-voiced-gap";
  if (pitchDelta >= mode.minimumDistinctPitchSemitones && isFastDistinctPitch(previous, event, nextEvent, mode)) {
    return "supported-fast-pitch-motion";
  }
  if (pitchDelta >= mode.minimumDistinctPitchSemitones &&
    event.duration >= mode.minimumStablePitchSeconds &&
    previous.duration >= mode.minimumStablePitchSeconds) {
    return "stable-pitch-change";
  }
  if (pitchDelta >= mode.minimumDistinctPitchSemitones && nextEvent &&
    nextEvent.midi === event.midi &&
    nextEvent.duration >= mode.minimumStablePitchSeconds &&
    nextEvent.startTime - event.endTime <= mode.maximumMergeGapSeconds) {
    return "pitch-change-followed-by-stability";
  }
  return null;
}

function mergeReason(previous, event, nextEvent, audioDuration, config, mode, keepDecision = null) {
  if (keepDecision || shouldKeepAsNewNote(previous, event, nextEvent, audioDuration, config, mode)) return null;
  const pitchDelta = Math.abs(previous.midi - event.midi);
  const gap = event.startTime - previous.endTime;
  const nearEnd = event.endTime >= audioDuration - mode.terminalTailWindowSeconds;
  const quieter = event.amplitude <= previous.amplitude * 0.86;
  if (nearEnd && pitchDelta <= mode.maximumDriftSemitones && gap <= mode.maximumTailGapSeconds &&
    (quieter || event.duration <= mode.maximumTailFragmentSeconds)) return "natural-terminal-tail";
  if (pitchDelta === 0 && gap < config.voice.phraseBreakMinimumSeconds) {
    return "same-pitch-continuation";
  }
  if (pitchDelta <= mode.maximumDriftSemitones && gap < config.voice.phraseBreakMinimumSeconds &&
    event.duration <= mode.maximumDriftFragmentSeconds) return "vibrato-or-brief-glide";
  if (pitchDelta <= mode.maximumDriftSemitones && gap <= mode.maximumMergeGapSeconds && quieter) {
    return "decaying-tail-fragment";
  }
  return null;
}

function stableSourceEvents(events) {
  if (events.length <= 3) return events;
  const amplitudeFloor = median(events.map((event) => event.amplitude)) * 0.68;
  const withoutEdges = events.slice(1, -1).filter((event) => event.amplitude >= amplitudeFloor);
  return withoutEdges.length ? withoutEdges : events.filter((event) => event.amplitude >= amplitudeFloor);
}

function createInterpretedNote(group, index, phrase) {
  const sources = group.events;
  const stable = stableSourceEvents(sources);
  const stableMidi = weightedMedian(
    stable,
    (event) => event.midi,
    (event) => event.amplitude * Math.max(0.04, event.duration) * (1 + event.onsetConfidence * 0.2)
  );
  const finalMidi = Math.round(stableMidi);
  const rawFrequency = weightedMedian(
    stable,
    (event) => event.frequency,
    (event) => event.amplitude * Math.max(0.04, event.duration)
  );
  const expectedFrequency = midiToFrequency(finalMidi);
  const centsDeviation = rawFrequency > 0 ? Math.round(1200 * Math.log2(rawFrequency / expectedFrequency)) : null;
  const stableStart = stable[0]?.startTime ?? sources[0].startTime;
  const stableEnd = stable[stable.length - 1]?.endTime ?? sources[sources.length - 1].endTime;
  const startTime = sources[0].startTime;
  const endTime = sources[sources.length - 1].endTime;
  return {
    id: `interpreted-${index + 1}`,
    midi: finalMidi,
    pitchName: midiToPitchName(finalMidi),
    frequency: expectedFrequency,
    rawPrimaryFrequency: rawFrequency || expectedFrequency,
    centsDeviation,
    startTime,
    endTime,
    duration: Math.max(0, endTime - startTime),
    amplitude: Math.max(...sources.map((event) => event.amplitude)),
    onsetConfidence: Math.max(...sources.map((event) => event.onsetConfidence)),
    articulationOnsetScore: Math.max(...sources.map((event) => event.articulationOnsetScore || 0)),
    articulationEvidence: sources.map((event) => event.articulationEvidence).filter(Boolean),
    stableRegion: { startTime: stableStart, endTime: stableEnd },
    sourceEventIds: sources.map((event) => event.id),
    mergedReasons: [...new Set(group.mergeReasons)],
    phraseId: phrase.id,
    phraseStart: phrase.startTime,
    phraseEnd: phrase.endTime,
    hasBreathBefore: phrase.hasBreathBefore && phrase.noteIndexes[0] === index,
    hasBreathAfter: phrase.hasBreathAfter && phrase.noteIndexes[phrase.noteIndexes.length - 1] === index,
    processing: {
      status: "interpreted",
      reason: group.mergeReasons.length ? group.mergeReasons.join(",") : "kept-distinct-note",
      mergedInto: null
    }
  };
}

function groupReference(group) {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  return {
    ...first,
    endTime: last.endTime,
    duration: last.endTime - first.startTime,
    amplitude: Math.max(...group.events.map((event) => event.amplitude)),
    onsetConfidence: Math.max(...group.events.map((event) => event.onsetConfidence))
  };
}

function gapHasSustainedSilence(gap, config) {
  if (gap.duration < config.voice.phraseBreakMinimumSeconds) return false;
  if (!gap.frames?.length) return gap.duration >= config.voice.phraseBreakMinimumSeconds + config.voice.phraseBridgeMaximumSeconds;
  const quietFrames = gap.frames.filter((frame) => frame.rms <= config.voice.phraseBreakEnergyFloor).length;
  return quietFrames / gap.frames.length >= config.voice.phraseQuietCoverage;
}

function assignPhrases(interpretedNotes, config, silenceGaps = []) {
  if (!interpretedNotes.length) return [];
  const phrases = [];
  let phrase = null;
  interpretedNotes.forEach((note, index) => {
    const previous = interpretedNotes[index - 1];
    const rawGap = previous ? Math.max(0, note.startTime - previous.endTime) : 0;
    const matchingGap = previous
      ? silenceGaps.find((gap) =>
        gap.startTime >= previous.startTime - config.voice.phraseQuietFrameSeconds &&
        gap.endTime <= note.endTime + config.voice.phraseQuietFrameSeconds
      )
      : null;
    const startsPhrase = !previous || gapHasSustainedSilence(matchingGap || { duration: rawGap }, config);
    if (startsPhrase) {
      phrase = {
        id: "phrase-" + (phrases.length + 1),
        startTime: note.startTime,
        endTime: note.endTime,
        hasBreathBefore: Boolean(previous),
        hasBreathAfter: false,
        noteIndexes: [index]
      };
      if (phrases.length) phrases[phrases.length - 1].hasBreathAfter = true;
      phrases.push(phrase);
      return;
    }
    phrase.endTime = note.endTime;
    phrase.noteIndexes.push(index);
  });
  return phrases;
}

/**
 * Turns Basic Pitch events into the notes a singer is likely to have intended.
 * It is event-based by design: no UI state or model inference is hidden here,
 * so every merge can be retained in the recognition diagnostic.
 */
export function interpretHummingMelody(rawInput, { audioDuration, mode = "standard", config = VOICE_RECOGNITION_CONFIG, silenceGaps = [], audioAnalysis = null } = {}) {
  const selectedMode = HUMMING_INTERPRETER_MODES[mode] || HUMMING_INTERPRETER_MODES.standard;
  const rawEvents = (Array.isArray(rawInput) ? rawInput : [])
    .map(cloneEvent)
    .sort((left, right) => left.startTime - right.startTime || right.amplitude - left.amplitude);
  const monophonicEvents = selectMonophonicEvents(rawEvents.map((event) => ({ ...event })), config);
  const duration = Number.isFinite(audioDuration)
    ? audioDuration
    : Math.max(0, ...monophonicEvents.map((event) => event.endTime));
  const groups = [];
  const boundaryDecisions = [];

  monophonicEvents.forEach((event, index) => {
    const previousGroup = groups[groups.length - 1];
    const previous = previousGroup ? groupReference(previousGroup) : null;
    const nextEvent = monophonicEvents[index + 1];
    const keepDecision = previous ? shouldKeepAsNewNote(previous, event, nextEvent, duration, config, selectedMode) : "initial-note";
    const reason = previous ? mergeReason(previous, event, nextEvent, duration, config, selectedMode, keepDecision) : null;
    boundaryDecisions.push({
      time: event.startTime,
      eventId: event.id,
      previousEventId: previous?.id || null,
      articulationOnsetScore: event.articulationOnsetScore || 0,
      energyRise: event.articulationEvidence?.energyRise ?? event.energyRise ?? 0,
      spectralFlux: event.articulationEvidence?.spectralFlux ?? 0,
      basicPitchOnset: event.articulationEvidence?.basicPitchOnset ?? event.onsetConfidence ?? 0,
      split: Boolean(!previousGroup || !reason),
      merged: Boolean(reason),
      reason: keepDecision || reason || "kept-distinct-note"
    });
    if (!previousGroup || !reason) {
      groups.push({ events: [event], mergeReasons: [] });
      return;
    }
    event.processing = { status: "merged", reason, mergedInto: previousGroup.events[0].id };
    previousGroup.events.push(event);
    previousGroup.mergeReasons.push(reason);
  });

  const preliminaryNotes = groups.map((group, index) => createInterpretedNote(group, index, {
    id: "pending",
    startTime: group.events[0].startTime,
    endTime: group.events[group.events.length - 1].endTime,
    hasBreathBefore: false,
    hasBreathAfter: false,
    noteIndexes: [index]
  }));
  const phrases = assignPhrases(preliminaryNotes, config, silenceGaps);
  const interpretedNotes = preliminaryNotes.map((note, index) => {
    const phrase = phrases.find((candidate) => candidate.noteIndexes.includes(index));
    return {
      ...note,
      phraseId: phrase.id,
      phraseStart: phrase.startTime,
      phraseEnd: phrase.endTime,
      hasBreathBefore: phrase.hasBreathBefore && phrase.noteIndexes[0] === index,
      hasBreathAfter: phrase.hasBreathAfter && phrase.noteIndexes[phrase.noteIndexes.length - 1] === index
    };
  });
  return {
    mode: HUMMING_INTERPRETER_MODES[mode] ? mode : "standard",
    version: HUMMING_INTERPRETER_VERSION,
    rawEvents,
    monophonicEvents,
    interpretedNotes,
    phrases,
    boundaryDecisions,
    audioAnalysis
  };
}

// Small compatibility surface for the existing deterministic script and any
// historical imports. The app uses interpretHummingMelody directly.
export function selectInterpretedNotes(notes, options = {}) {
  const rawEvents = notes.map((note, index) => cloneEvent({
    ...note,
    id: note.id || `test-${index + 1}`,
    midi: note.midi ?? note.pitchMidi,
    startTime: note.startTime ?? note.startTimeSeconds,
    endTime: note.endTime ?? (note.startTimeSeconds + note.durationSeconds),
    duration: note.duration ?? note.durationSeconds
  }, index));
  return interpretHummingMelody(rawEvents, options).interpretedNotes;
}
