import {
  RECOGNITION_ENGINE_VERSION,
  VOICE_RECOGNITION_CONFIG,
  getVoiceRecognitionConfigSnapshot
} from "./voiceRecognitionConfig.js";
import { interpretHummingMelody, selectInterpretedNotes } from "./hummingMelodyInterpreter.js";
import { analyzeVocalArticulation, articulationEvidenceNear } from "./vocalArticulationAnalyzer.js";

const BASIC_PITCH_SAMPLE_RATE = 22050;
const BASIC_PITCH_BASE_URL = import.meta.env?.BASE_URL || "/";
const BASIC_PITCH_MODEL_URL = `${BASIC_PITCH_BASE_URL}basic-pitch/model.json`;
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let basicPitchToolsPromise = null;

function midiToPitchName(midi) {
  const rounded = Math.round(midi);
  return `${noteNames[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function mixToMono(audioBuffer) {
  const mixed = new Float32Array(audioBuffer.length);
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      mixed[index] += samples[index] / channelCount;
    }
  }

  return mixed;
}

function resampleLinearly(samples, sourceRate, targetRate) {
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const right = Math.min(samples.length - 1, left + 1);
    const amount = sourcePosition - left;
    output[index] = samples[left] * (1 - amount) + samples[right] * amount;
  }

  return output;
}

async function resampleForBasicPitch(audioBuffer) {
  const mono = mixToMono(audioBuffer);
  if (audioBuffer.sampleRate === BASIC_PITCH_SAMPLE_RATE) return mono;

  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) {
    return resampleLinearly(mono, audioBuffer.sampleRate, BASIC_PITCH_SAMPLE_RATE);
  }

  const frameLength = Math.max(1, Math.ceil(audioBuffer.duration * BASIC_PITCH_SAMPLE_RATE));
  const offlineContext = new OfflineContext(1, frameLength, BASIC_PITCH_SAMPLE_RATE);
  const monoBuffer = offlineContext.createBuffer(1, mono.length, audioBuffer.sampleRate);
  monoBuffer.copyToChannel(mono, 0);
  const source = offlineContext.createBufferSource();
  source.buffer = monoBuffer;
  source.connect(offlineContext.destination);
  source.start();
  const rendered = await offlineContext.startRendering();
  return rendered.getChannelData(0).slice();
}

async function loadBasicPitchTools() {
  if (!basicPitchToolsPromise) basicPitchToolsPromise = import("@spotify/basic-pitch");
  return basicPitchToolsPromise;
}

function extractSustainedSilenceGaps(samples, config) {
  const windowSamples = Math.max(1, Math.round(config.voice.phraseQuietFrameSeconds * BASIC_PITCH_SAMPLE_RATE));
  const frames = [];
  for (let offset = 0; offset + windowSamples <= samples.length; offset += windowSamples) {
    let energy = 0;
    for (let index = 0; index < windowSamples; index += 1) energy += samples[offset + index] ** 2;
    frames.push({
      startTime: offset / BASIC_PITCH_SAMPLE_RATE,
      endTime: (offset + windowSamples) / BASIC_PITCH_SAMPLE_RATE,
      rms: Math.sqrt(energy / windowSamples)
    });
  }

  const gaps = [];
  let current = null;
  frames.forEach((frame) => {
    if (frame.rms <= config.voice.phraseBreakEnergyFloor) {
      if (!current) current = { startTime: frame.startTime, endTime: frame.endTime, frames: [frame] };
      else {
        current.endTime = frame.endTime;
        current.frames.push(frame);
      }
      return;
    }
    if (current) {
      current.duration = current.endTime - current.startTime;
      if (current.duration >= config.voice.phraseBreakMinimumSeconds) gaps.push(current);
      current = null;
    }
  });
  if (current) {
    current.duration = current.endTime - current.startTime;
    if (current.duration >= config.voice.phraseBreakMinimumSeconds) gaps.push(current);
  }
  return gaps;
}

function meanSquare(samples, startTime, endTime) {
  const start = Math.max(0, Math.floor(startTime * BASIC_PITCH_SAMPLE_RATE));
  const end = Math.min(samples.length, Math.ceil(endTime * BASIC_PITCH_SAMPLE_RATE));
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += samples[index] ** 2;
  return Math.sqrt(total / (end - start));
}

function onsetConfidenceForEvent(event, onsets) {
  if (!onsets.length) return 0;
  const approximateFrame = Math.max(0, Math.round(event.startTime * (BASIC_PITCH_SAMPLE_RATE / 256)));
  const pitchBin = Math.max(0, Math.min(87, Math.round(event.midi) - 21));
  let confidence = 0;
  for (let offset = -1; offset <= 1; offset += 1) {
    const row = onsets[approximateFrame + offset];
    if (!row) continue;
    confidence = Math.max(confidence, row[pitchBin] || 0);
  }
  return confidence;
}

function createRawEvent(note, index, onsets, samples) {
  const startTime = Math.max(0, note.startTimeSeconds);
  const duration = Math.max(0, note.durationSeconds);
  const endTime = startTime + duration;
  const preEnergy = meanSquare(samples, Math.max(0, startTime - 0.08), Math.max(0, startTime - 0.015));
  const attackEnergy = meanSquare(samples, startTime, Math.min(endTime, startTime + 0.07));
  const energyRise = attackEnergy / Math.max(preEnergy, 0.00001);

  return {
    id: `bp-${index + 1}`,
    midi: Math.round(note.pitchMidi),
    pitchName: midiToPitchName(note.pitchMidi),
    frequency: midiToFrequency(note.pitchMidi),
    startTime,
    endTime,
    duration,
    amplitude: note.amplitude,
    onsetConfidence: onsetConfidenceForEvent({ startTime, midi: note.pitchMidi }, onsets),
    preEnergy,
    attackEnergy,
    energyRise,
    processing: { status: "raw", reason: null, mergedInto: null }
  };
}

function decorateWithArticulation(event, analysis, config) {
  const evidence = articulationEvidenceNear(event.startTime, analysis, config.voice.articulationBoundaryWindowSeconds);
  return {
    ...event,
    articulationOnsetScore: evidence?.articulationOnsetScore || 0,
    articulationEvidence: evidence ? { ...evidence } : null
  };
}

function articulationEventsForNote(note, analysis, config) {
  const events = analysis?.articulationEvents || analysis?.candidates || [];
  const padding = Math.max(
    config.voice.articulationMinimumSegmentSeconds,
    config.voice.fastArticulationMinimumSegmentSeconds || 0
  );
  return events
    .filter((event) => {
      const eventStart = event.startTime ?? event.time;
      return eventStart >= note.startTime - padding && eventStart <= note.endTime + padding;
    })
    .sort((left, right) => (left.startTime ?? left.time) - (right.startTime ?? right.time) || left.time - right.time);
}

function onsetStabilityWindow(note, config) {
  return Math.min(
    config.voice.onsetStabilityMaximumSeconds,
    Math.max(config.voice.onsetStabilityMinimumSeconds, note.duration * config.voice.onsetStabilityRelativeDuration)
  );
}

function hasIndependentBoundaryEvidence(event) {
  if (event.canSplitStableNote === false) return false;
  if (event.isIndependentReattack === true) return true;
  // Stored diagnostics from older local projects do not carry the event flag.
  return Boolean(event.independentEnergyReset || event.modelTransient || event.canSplitStableNote === undefined);
}

function boundaryMinimumSegment(event, config) {
  const hasFastEvidence = Boolean(event.independentEnergyReset || event.modelTransient || event.isIndependentReattack);
  return hasFastEvidence
    ? config.voice.fastArticulationMinimumSegmentSeconds
    : config.voice.articulationMinimumSegmentSeconds;
}

function decisionForBoundary(note, event, boundaryTime, split, reason, extra = {}) {
  return {
    time: boundaryTime,
    eventId: note.id,
    previousEventId: note.id,
    articulationEventId: event.id || null,
    rawPeakIds: event.rawPeakIds || [],
    rawPeakCount: event.peakCount || 1,
    sources: event.sources || [],
    articulationOnsetScore: event.articulationOnsetScore || 0,
    energyRise: event.energyRise || 0,
    energyValleyRatio: event.energyValleyRatio ?? null,
    spectralFlux: event.spectralFlux || 0,
    basicPitchOnset: event.basicPitchOnset || 0,
    split,
    merged: !split,
    reason,
    pitchSource: "stable-basic-pitch-note",
    inheritedMidi: note.midi,
    ...extra
  };
}

function splitStableNoteAtArticulation(note, analysis, config) {
  const events = articulationEventsForNote(note, analysis, config);
  if (!events.length) return { notes: [note], decisions: [] };

  const decisions = [];
  const accepted = [];
  let previousCut = note.startTime;
  events.forEach((event) => {
    const boundaryTime = event.startTime ?? event.time;
    if (!Number.isFinite(boundaryTime) || boundaryTime <= note.startTime || boundaryTime >= note.endTime) return;
    if (!hasIndependentBoundaryEvidence(event)) {
      decisions.push(decisionForBoundary(note, event, boundaryTime, false, "clustered-or-initial-onset-detail"));
      return;
    }
    const minimumSegment = boundaryMinimumSegment(event, config);
    const elapsedSincePreviousCut = boundaryTime - previousCut;
    const remaining = note.endTime - boundaryTime;
    const initialStabilityWindow = onsetStabilityWindow(note, config);
    const independentEvidence = Boolean(event.independentEnergyReset || event.modelTransient || event.isIndependentReattack);
    if (elapsedSincePreviousCut < minimumSegment || remaining < minimumSegment) {
      decisions.push(decisionForBoundary(note, event, boundaryTime, false, "insufficient-stable-segment", { minimumSegment }));
      return;
    }
    // The first vowel is allowed to settle. A close secondary peak can only
    // split it when it has independently proved a fresh re-attack.
    if (elapsedSincePreviousCut < initialStabilityWindow && !independentEvidence) {
      decisions.push(decisionForBoundary(note, event, boundaryTime, false, "onset-stability-protection", { initialStabilityWindow }));
      return;
    }
    accepted.push({ event, time: boundaryTime });
    previousCut = boundaryTime;
    decisions.push(decisionForBoundary(note, event, boundaryTime, true, "post-pitch-independent-articulation-split", { minimumSegment }));
  });
  if (!accepted.length) return { notes: [note], decisions };

  const cuts = [note.startTime, ...accepted.map((item) => item.time), note.endTime];
  const segments = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const startTime = cuts[index];
    const endTime = cuts[index + 1];
    if (endTime <= startTime) continue;
    const boundary = index ? accepted[index - 1].event : null;
    segments.push({
      ...note,
      id: segments.length ? note.id + "-art-" + (segments.length + 1) : note.id,
      // Articulation determines time only. Each new segment retains the stable
      // Basic Pitch MIDI selected before consonant/attack analysis.
      midi: note.midi,
      pitchName: note.pitchName,
      frequency: note.frequency,
      rawPrimaryFrequency: note.rawPrimaryFrequency,
      startTime,
      endTime,
      duration: endTime - startTime,
      sourceStableNoteId: note.id,
      articulationOnsetScore: Math.max(note.articulationOnsetScore || 0, boundary?.articulationOnsetScore || 0),
      articulationEvidence: boundary ? [ ...(Array.isArray(note.articulationEvidence) ? note.articulationEvidence : []), { ...boundary } ] : note.articulationEvidence,
      processing: {
        status: "articulation-time-split",
        reason: boundary ? "clustered-articulation-boundary:" + boundary.reason : note.processing?.reason || "stable-pitch",
        mergedInto: null
      }
    });
  }
  return { notes: segments.length ? segments : [note], decisions };
}

function refreshPhraseMetadata(notes) {
  const groups = new Map();
  notes.forEach((note) => {
    const phraseId = note.phraseId || "phrase-1";
    if (!groups.has(phraseId)) groups.set(phraseId, []);
    groups.get(phraseId).push(note);
  });
  return notes.map((note) => {
    const phrase = groups.get(note.phraseId || "phrase-1") || [note];
    const first = phrase[0];
    const last = phrase[phrase.length - 1];
    return {
      ...note,
      phraseStart: first.startTime,
      phraseEnd: last.endTime,
      hasBreathBefore: note === first ? Boolean(first.hasBreathBefore) : false,
      hasBreathAfter: note === last ? Boolean(last.hasBreathAfter) : false
    };
  });
}

export function applyArticulationBoundariesToStableNotes(notes, analysis, config = VOICE_RECOGNITION_CONFIG) {
  const decisions = [];
  const splitNotes = notes.flatMap((note) => {
    const result = splitStableNoteAtArticulation(note, analysis, config);
    decisions.push(...result.decisions);
    return result.notes;
  });
  return { notes: refreshPhraseMetadata(splitNotes), decisions };
}

function extractFramePitchTrack(frames, config) {
  const minimumMidi = config.voice.minimumMidi;
  const maximumMidi = config.voice.maximumMidi;
  return frames.map((frame, index) => {
    let confidence = 0;
    let pitchIndex = -1;
    for (let itemIndex = 0; itemIndex < frame.length; itemIndex += 1) {
      const value = Number(frame[itemIndex]) || 0;
      if (value > confidence) {
        confidence = value;
        pitchIndex = itemIndex;
      }
    }
    const midi = pitchIndex + 21;
    return {
      time: Number((index * 256 / BASIC_PITCH_SAMPLE_RATE).toFixed(6)),
      midi,
      confidence: Number(confidence.toFixed(4)),
      valid: pitchIndex >= 0 && midi >= minimumMidi && midi <= maximumMidi
    };
  });
}


function stableVowelMidiForNote(note, framePitchTrack, config) {
  const duration = Math.max(0, note.endTime - note.startTime);
  const leadIn = Math.min(0.06, Math.max(0.022, duration * 0.22));
  const tail = Math.min(0.04, Math.max(0.016, duration * 0.16));
  const start = note.startTime + leadIn;
  const end = note.endTime - tail;
  if (end <= start) return null;
  const supportingFrames = framePitchTrack.filter((frame) =>
    frame.valid && frame.confidence >= config.fastPitchRecovery.minimumFrameConfidence &&
    frame.time >= start && frame.time <= end
  );
  if (supportingFrames.length < config.fastPitchRecovery.minimumStableFrames) return null;
  const byMidi = new Map();
  supportingFrames.forEach((frame) => {
    const record = byMidi.get(frame.midi) || { midi: frame.midi, frames: 0, confidenceTotal: 0 };
    record.frames += 1;
    record.confidenceTotal += frame.confidence;
    byMidi.set(frame.midi, record);
  });
  const strongest = [...byMidi.values()]
    .sort((left, right) => right.frames - left.frames || right.confidenceTotal - left.confidenceTotal)[0];
  const confidence = strongest.confidenceTotal / strongest.frames;
  const coverage = strongest.frames / supportingFrames.length;
  if (strongest.frames < config.fastPitchRecovery.minimumStableFrames ||
    confidence < config.fastPitchRecovery.minimumFrameConfidence || coverage < 0.62) return null;
  return { midi: strongest.midi, frames: strongest.frames, confidence: Number(confidence.toFixed(4)), coverage: Number(coverage.toFixed(4)), start, end };
}

// The only post-split MIDI correction reads the middle of a note's own stable
// vowel frames. Attack, flux, and articulation data are intentionally excluded.
export function stabilizeSegmentPitchesFromFrameTrack(notes, framePitchTrack, config = VOICE_RECOGNITION_CONFIG) {
  const decisions = [];
  const stabilized = notes.map((note) => {
    const support = stableVowelMidiForNote(note, framePitchTrack, config);
    if (!support || support.midi === note.midi) {
      decisions.push({
        noteId: note.id,
        action: "kept-basic-pitch-midi",
        midi: note.midi,
        support: support || null,
        reason: support ? "stable-vowel-agrees" : "no-sufficient-stable-vowel-support"
      });
      return note;
    }
    const expectedFrequency = midiToFrequency(support.midi);
    decisions.push({
      noteId: note.id,
      action: "stable-vowel-midi-correction",
      previousMidi: note.midi,
      midi: support.midi,
      support,
      reason: "independent-basic-pitch-frame-centre"
    });
    return {
      ...note,
      midi: support.midi,
      pitchName: midiToPitchName(support.midi),
      frequency: expectedFrequency,
      rawPrimaryFrequency: note.rawPrimaryFrequency || expectedFrequency,
      framePitchStabilized: true,
      processing: {
        ...note.processing,
        status: "frame-pitch-stabilized",
        reason: "stable-vowel-basic-pitch-frame-centre"
      }
    };
  });
  return { notes: refreshPhraseMetadata(stabilized), decisions };
}


function stableFramePitchRegions(framePitchTrack, config) {
  const settings = config.fastPitchRecovery;
  const hopSeconds = 256 / BASIC_PITCH_SAMPLE_RATE;
  const regions = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const duration = current.endTime - current.startTime + hopSeconds;
    const confidence = current.confidenceTotal / current.frameCount;
    if (current.frameCount >= settings.minimumStableFrames &&
      duration >= settings.minimumStableSeconds &&
      confidence >= settings.minimumFrameConfidence) {
      regions.push({
        ...current,
        duration: Number(duration.toFixed(6)),
        confidence: Number(confidence.toFixed(4))
      });
    }
    current = null;
  };

  framePitchTrack.forEach((frame) => {
    const canContinue = current && frame.valid && frame.midi === current.midi &&
      frame.time - current.endTime <= settings.maximumFrameGapSeconds;
    if (!canContinue) finish();
    if (!frame.valid || frame.confidence < settings.minimumFrameConfidence) return;
    if (!current) {
      current = {
        midi: frame.midi,
        startTime: frame.time,
        endTime: frame.time,
        frameCount: 0,
        confidenceTotal: 0
      };
    }
    current.endTime = frame.time;
    current.frameCount += 1;
    current.confidenceTotal += frame.confidence;
  });
  finish();
  return regions;
}

// A deliberately conservative repair for a fast melodic run: only Basic
// Pitch's own stable frame centres can supply a missing MIDI. Articulation is
// never consulted here, so a consonant cannot manufacture a wrong pitch.
export function recoverFastRunFromFramePitchTrack(notes, framePitchTrack, config = VOICE_RECOGNITION_CONFIG) {
  const settings = config.fastPitchRecovery;
  const hopSeconds = 256 / BASIC_PITCH_SAMPLE_RATE;
  const regions = stableFramePitchRegions(framePitchTrack, config);
  let best = null;

  for (let start = 0; start < regions.length; start += 1) {
    const run = [];
    for (let index = start; index < regions.length; index += 1) {
      const previous = run[run.length - 1];
      const region = regions[index];
      if (previous && region.startTime - previous.endTime > settings.maximumRegionGapSeconds) break;
      run.push(region);
      const span = region.endTime - run[0].startTime + hopSeconds;
      const midis = run.map((item) => item.midi);
      const distinct = new Set(midis);
      const range = Math.max(...midis) - Math.min(...midis);
      if (span > settings.maximumRunSeconds) break;
      if (run.length < settings.minimumDistinctCenters || distinct.size < settings.minimumDistinctCenters ||
        range < settings.minimumPitchRangeSemitones) continue;
      const overlapIndexes = notes
        .map((note, noteIndex) => ({ note, noteIndex }))
        .filter(({ note }) => note.endTime > run[0].startTime && note.startTime < region.endTime + hopSeconds)
        .map(({ noteIndex }) => noteIndex);
      if (!overlapIndexes.length || overlapIndexes.length >= run.length) continue;
      const first = notes[overlapIndexes[0]];
      const last = notes[overlapIndexes[overlapIndexes.length - 1]];
      if (first.phraseId !== last.phraseId ||
        first.startTime > run[0].startTime + settings.maximumCoverageSlackSeconds ||
        last.endTime < region.endTime + hopSeconds - settings.maximumCoverageSlackSeconds) continue;
      const candidate = { run: [...run], overlapIndexes };
      if (!best || candidate.run.length > best.run.length) best = candidate;
    }
  }

  if (!best) return { notes, regions, decision: null };
  const firstIndex = best.overlapIndexes[0];
  const lastIndex = best.overlapIndexes[best.overlapIndexes.length - 1];
  const firstSource = notes[firstIndex];
  const lastSource = notes[lastIndex];
  const recovered = best.run.map((region, index) => {
    const next = best.run[index + 1];
    const startTime = index === 0 ? firstSource.startTime : region.startTime;
    const endTime = index === best.run.length - 1 ? lastSource.endTime : next.startTime;
    return {
      ...firstSource,
      id: "frame-run-" + (firstIndex + 1) + "-" + (index + 1),
      midi: region.midi,
      pitchName: midiToPitchName(region.midi),
      frequency: midiToFrequency(region.midi),
      rawPrimaryFrequency: midiToFrequency(region.midi),
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      onsetConfidence: region.confidence,
      sourceEventIds: ["basic-pitch-frame-track"],
      processing: {
        status: "frame-pitch-run-recovered",
        reason: "stable-basic-pitch-frame-centers",
        mergedInto: null
      }
    };
  });
  const nextNotes = [
    ...notes.slice(0, firstIndex),
    ...recovered,
    ...notes.slice(lastIndex + 1)
  ];
  return {
    notes: refreshPhraseMetadata(nextNotes),
    regions,
    decision: {
      time: recovered[0].startTime,
      eventId: firstSource.id,
      previousEventId: null,
      articulationOnsetScore: 0,
      energyRise: 0,
      spectralFlux: 0,
      basicPitchOnset: 0,
      split: true,
      merged: false,
      reason: "stable-frame-pitch-run-recovery",
      pitchSource: "basic-pitch-frame-track",
      recoveredMidis: recovered.map((note) => note.midi)
    }
  };
}

// Exported for the deterministic benchmark suite; app recognition uses the
// richer function below so it can save every intermediate decision.
export function selectMonophonicNotes(notes, options = {}) {
  return selectInterpretedNotes(notes, options);
}

export async function detectMonophonicNotesWithBasicPitch(blob, audioContext, onProgress = () => {}, options = {}) {
  const inferenceStartedAt = performance.now();
  const decoded = await audioContext.decodeAudioData((await blob.arrayBuffer()).slice(0));
  const samples = await resampleForBasicPitch(decoded);
  const { BasicPitch, noteFramesToTime, outputToNotesPoly } = await loadBasicPitchTools();
  const frames = [];
  const onsets = [];
  const contours = [];
  const config = VOICE_RECOGNITION_CONFIG;
  const transcriber = new BasicPitch(BASIC_PITCH_MODEL_URL);

  await transcriber.evaluateModel(
    samples,
    (frameBatch, onsetBatch, contourBatch) => {
      frames.push(...frameBatch);
      onsets.push(...onsetBatch);
      contours.push(...contourBatch);
    },
    (progress) => onProgress(Math.max(0, Math.min(1, progress)))
  );

  const noteFrames = outputToNotesPoly(
    frames,
    onsets,
    config.basicPitch.onsetThreshold,
    config.basicPitch.frameThreshold,
    config.basicPitch.minimumNoteFrames,
    config.basicPitch.inferOnsets,
    config.basicPitch.maximumFrequency,
    config.basicPitch.minimumFrequency,
    false,
    config.basicPitch.energyToleranceFrames
  );
  const rawBasicPitchEvents = noteFramesToTime(noteFrames)
    .map((note, index) => createRawEvent(note, index, onsets, samples))
    .sort((left, right) => left.startTime - right.startTime);
  const silenceGaps = extractSustainedSilenceGaps(samples, config);
  // This stays fully in-browser. It detects consonant-like re-attacks even when
  // pitch is unchanged and there is no breath between syllables.
  const audioAnalysis = analyzeVocalArticulation(samples, {
    sampleRate: BASIC_PITCH_SAMPLE_RATE,
    onsets,
    config
  });
  // Keep model events intact while the stable monophonic path selects MIDI.
  // Articulation evidence is metadata here, not a pre-selection time split.
  const pitchSelectionInputEvents = rawBasicPitchEvents
    .map((event) => decorateWithArticulation(event, audioAnalysis, config));
  const interpreted = interpretHummingMelody(pitchSelectionInputEvents, {
    audioDuration: samples.length / BASIC_PITCH_SAMPLE_RATE,
    mode: options.interpreterMode || "standard",
    config,
    silenceGaps,
    audioAnalysis
  });
  const preArticulationInterpretedNotes = interpreted.interpretedNotes;
  const postArticulation = applyArticulationBoundariesToStableNotes(preArticulationInterpretedNotes, audioAnalysis, config);
  const framePitchTrack = extractFramePitchTrack(frames, config);
  const pitchStabilization = stabilizeSegmentPitchesFromFrameTrack(postArticulation.notes, framePitchTrack, config);
  const fastPitchRecovery = recoverFastRunFromFramePitchTrack(pitchStabilization.notes, framePitchTrack, config);
  const finalNotes = fastPitchRecovery.notes;
  const finalBoundaryDecisions = [
    ...interpreted.boundaryDecisions,
    ...postArticulation.decisions,
    ...(fastPitchRecovery.decision ? [fastPitchRecovery.decision] : [])
  ];

  return {
    events: finalNotes,
    diagnostics: {
      recognitionEngine: "basic-pitch",
      recognitionVersion: RECOGNITION_ENGINE_VERSION,
      modelLoadStatus: "loaded",
      fallbackReason: null,
      inferenceDurationMs: Math.round(performance.now() - inferenceStartedAt),
      recognitionConfigVersion: config.version,
      recognitionConfig: getVoiceRecognitionConfigSnapshot(),
      rawBasicPitchEventCount: rawBasicPitchEvents.length,
      articulationEventCount: pitchSelectionInputEvents.length,
      articulationSplitCount: Math.max(0, finalNotes.length - preArticulationInterpretedNotes.length),
      audioAnalysis,
      framePitchTrack,
      stableFramePitchRegions: fastPitchRecovery.regions,
      pitchStabilizationDecisions: pitchStabilization.decisions,
      fastPitchRecoveryApplied: Boolean(fastPitchRecovery.decision),
      sustainedSilenceGapCount: silenceGaps.length,
      sustainedSilenceGaps: silenceGaps.map(({ startTime, endTime, duration }) => ({ startTime, endTime, duration })),
      interpreterMode: interpreted.mode,
      interpreterVersion: interpreted.version,
      monophonicEventCount: interpreted.monophonicEvents.length,
      mergedEventCount: interpreted.monophonicEvents.length - preArticulationInterpretedNotes.length,
      interpretedEventCount: preArticulationInterpretedNotes.length,
      finalEventCount: finalNotes.length,
      finalNoteCount: finalNotes.length,
      rawBasicPitchEvents,
      articulationEvents: pitchSelectionInputEvents,
      monophonicEvents: interpreted.monophonicEvents,
      preArticulationInterpretedNotes,
      postArticulationNotes: postArticulation.notes,
      pitchStabilizedNotes: pitchStabilization.notes,
      // Kept for older stored diagnostics. interpretedNotes is the canonical result.
      mergedEvents: preArticulationInterpretedNotes,
      interpretedNotes: finalNotes,
      phrases: refreshPhraseMetadata(finalNotes).reduce((phrases, note) => {
        if (!phrases.some((phrase) => phrase.id === note.phraseId)) {
          phrases.push({ id: note.phraseId, startTime: note.phraseStart, endTime: note.phraseEnd });
        }
        return phrases;
      }, []),
      boundaryDecisions: finalBoundaryDecisions,
      finalEvents: finalNotes
    }
  };
}
