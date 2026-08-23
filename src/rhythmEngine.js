import {
  DEFAULT_RHYTHM_SETTINGS,
  getMeasureBeats,
  getTimeSignature,
  QUANTIZATION_GRIDS,
  QUANTIZATION_MODES,
  RHYTHM_ENGINE_VERSION
} from "./rhythmConfig.js";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, precision = 6) {
  const power = 10 ** precision;
  return Math.round(value * power) / power;
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

const QUANTIZATION_GUARDRAILS = Object.freeze({
  original: Object.freeze({ maxStartShiftGrid: 0, maxDurationChangeRatio: 0, maxTotalDurationChangeRatio: 0 }),
  light: Object.freeze({ maxStartShiftGrid: 0.22, maxDurationChangeRatio: 0.26, maxTotalDurationChangeRatio: 0.1 }),
  standard: Object.freeze({ maxStartShiftGrid: 0.38, maxDurationChangeRatio: 0.4, maxTotalDurationChangeRatio: 0.16 }),
  strong: Object.freeze({ maxStartShiftGrid: 0.5, maxDurationChangeRatio: 0.5, maxTotalDurationChangeRatio: 0.22 })
});

function quantizationGuardrail(mode) {
  return QUANTIZATION_GUARDRAILS[mode] || QUANTIZATION_GUARDRAILS.standard;
}

function noteDuration(note, fallbackBeatSeconds) {
  const start = number(note.startTime, 0);
  const end = number(note.endTime, start);
  return Math.max(0.04, number(note.noteSeconds, end > start ? end - start : number(note.beats, 1) * fallbackBeatSeconds));
}

function durationDisplay(beats) {
  const values = [
    [0.125, "三十二分"], [0.25, "十六分"], [0.5, "八分"], [0.75, "附点八分"], [1, "四分"],
    [1.5, "附点四分"], [2, "二分"], [3, "附点二分"], [4, "全音"]
  ];
  return values.find(([value]) => Math.abs(value - beats) < 0.01)?.[1] || (beats > 4 ? "延长全音" : "短音");
}

function noteValue(beats) {
  const mapping = [
    [0.25, "sixteenth", false], [0.5, "eighth", false], [0.75, "eighth", true],
    [1, "quarter", false], [1.5, "quarter", true], [2, "half", false],
    [3, "half", true], [4, "whole", false]
  ];
  if (beats <= 0.25) return { noteValue: "sixteenth", dotted: false };
  const resolved = mapping.find(([value]) => Math.abs(value - beats) < 0.01) || [4, "whole", false];
  return { noteValue: resolved[1], dotted: resolved[2] };
}

function uniqueCandidates(values) {
  return [...new Set(values.map((value) => Math.round(value)).filter((value) => value >= 40 && value <= 200))];
}

export function estimateRhythm(notes, fallbackBpm = 80) {
  const onsets = notes
    .map((note) => number(note.startTime, 0))
    .sort((left, right) => left - right);
  const intervals = onsets
    .slice(1)
    .map((start, index) => start - onsets[index])
    .filter((interval) => interval >= 0.12 && interval <= 2.4);

  if (intervals.length < 2) {
    const candidates = uniqueCandidates([fallbackBpm, fallbackBpm / 2, fallbackBpm * 2]);
    return {
      detectedBpm: fallbackBpm,
      bpmConfidence: 0.16,
      bpmCandidates: candidates,
      detectedTimeSignature: "4/4",
      timeSignatureConfidence: 0.12,
      source: "insufficient-onsets"
    };
  }

  const medianInterval = median(intervals);
  let baseBpm = 60 / medianInterval;
  while (baseBpm < 70) baseBpm *= 2;
  while (baseBpm > 150) baseBpm /= 2;
  const deviations = intervals.map((interval) => Math.abs(interval - medianInterval));
  const consistency = 1 - clamp(median(deviations) / Math.max(medianInterval, 0.001), 0, 1);
  const coverage = clamp(intervals.length / 8, 0, 1);
  const bpmConfidence = round(clamp(consistency * 0.62 + coverage * 0.3, 0.16, 0.9), 3);
  const candidateBpm = Math.round(baseBpm);
  const timeSignature = recommendTimeSignature(notes, candidateBpm);

  return {
    detectedBpm: candidateBpm,
    bpmConfidence,
    bpmCandidates: uniqueCandidates([candidateBpm, candidateBpm / 2, candidateBpm * 2]),
    detectedTimeSignature: timeSignature.value,
    timeSignatureConfidence: timeSignature.confidence,
    source: "onset-intervals"
  };
}

export function recommendTimeSignature(notes, bpm) {
  if (notes.length < 5) return { value: "4/4", confidence: 0.15, source: "fallback" };
  const starts = notes.map((note) => number(note.startTime, 0) * bpm / 60);
  const scores = ["4/4", "3/4", "6/8"].map((value) => {
    const measureBeats = getMeasureBeats(value);
    const alignment = starts.reduce((total, start) => {
      const beatInMeasure = ((start % measureBeats) + measureBeats) % measureBeats;
      const distance = Math.min(beatInMeasure, Math.abs(measureBeats - beatInMeasure));
      return total + 1 - clamp(distance / Math.max(0.5, measureBeats / 2), 0, 1);
    }, 0) / starts.length;
    return { value, score: alignment };
  }).sort((left, right) => right.score - left.score);
  const best = scores[0];
  const lead = best.score - scores[1].score;
  if (lead < 0.08) return { value: "4/4", confidence: round(0.2 + Math.max(0, lead), 3), source: "low-confidence-fallback" };
  return { value: best.value, confidence: round(clamp(0.22 + lead * 1.9, 0.22, 0.72), 3), source: "onset-alignment" };
}

export function createRhythmMetadata(notes, options = {}) {
  const fallbackBpm = clamp(number(options.fallbackBpm, DEFAULT_RHYTHM_SETTINGS.selectedBpm), 40, 200);
  const estimated = estimateRhythm(notes, fallbackBpm);
  const bpmSource = options.bpmSource || (options.metronomeEnabled ? "metronome" : "detected");
  const selectedBpm = clamp(number(options.selectedBpm, bpmSource === "metronome" ? fallbackBpm : estimated.detectedBpm), 40, 200);
  const selectedTimeSignature = getTimeSignature(options.selectedTimeSignature || (bpmSource === "metronome" ? options.metronomeTimeSignature : estimated.detectedTimeSignature)).value;
  const rhythmSource = options.rhythmSource === "quantized" && Boolean(options.quantizationEnabled) ? "quantized" : "original";
  return {
    ...estimated,
    selectedBpm,
    bpmSource,
    selectedTimeSignature,
    quantizationEnabled: rhythmSource === "quantized",
    quantizationMode: options.quantizationMode || "original",
    quantizationGrid: options.quantizationGrid || "eighth",
    quantizationVersion: RHYTHM_ENGINE_VERSION,
    quantizationPreviewStatus: options.quantizationPreviewStatus || "idle",
    quantizationDiagnostics: options.quantizationDiagnostics || null,
    rhythmSource,
    naturalTempo: number(options.naturalTempo, 0),
    naturalBeatUnitSeconds: number(options.naturalBeatUnitSeconds, 0)
  };
}

function nearestGrid(value, grid) {
  return Math.round(value / grid) * grid;
}

function blendToGrid(value, grid, strength) {
  const target = nearestGrid(value, grid);
  return round(value + (target - value) * strength);
}

function createMeasures(totalBeats, signatureValue) {
  const signature = getTimeSignature(signatureValue);
  const measureBeats = getMeasureBeats(signatureValue);
  const totalMeasures = Math.max(1, Math.ceil(Math.max(totalBeats, 0.01) / measureBeats));
  return Array.from({ length: totalMeasures }, (_, index) => ({
    index: index + 1,
    startBeat: round(index * measureBeats),
    durationBeats: measureBeats,
    timeSignature: signature.value
  }));
}

function enrichNote(note, timing, bpm, signatureValue, grid, previous) {
  const signature = getTimeSignature(signatureValue);
  const measureBeats = getMeasureBeats(signatureValue);
  const startBeat = Math.max(0, timing.startBeat);
  const durationBeats = Math.max(grid * 0.25, timing.durationBeats);
  const endBeat = startBeat + durationBeats;
  const secondsPerBeat = 60 / bpm;
  const startTime = round(startBeat * secondsPerBeat);
  const endTime = round(endBeat * secondsPerBeat);
  const beatUnit = 4 / signature.denominator;
  const beatInMeasure = Math.floor((((startBeat % measureBeats) + measureBeats) % measureBeats) / beatUnit) + 1;
  const value = noteValue(durationBeats);
  const rawGap = previous ? Math.max(0, startTime - number(previous.endTime, startTime)) : Math.max(0, startTime);
  return {
    ...note,
    startTime,
    endTime,
    noteSeconds: round(endTime - startTime),
    durationSeconds: round(endTime - startTime),
    beats: durationBeats,
    duration: durationDisplay(durationBeats),
    startBeat: round(startBeat),
    durationBeats: round(durationBeats),
    measureIndex: Math.floor(startBeat / measureBeats) + 1,
    beatInMeasure,
    ...value,
    triplet: false,
    restBefore: rawGap >= secondsPerBeat * grid * 0.45 ? round(rawGap) : 0,
    confidence: number(note.confidence, number(note.amplitude, 0))
  };
}

function annotateOriginalNote(note, bpm, signatureValue, grid, previous) {
  const secondsPerBeat = 60 / bpm;
  const signature = getTimeSignature(signatureValue);
  const measureBeats = getMeasureBeats(signatureValue);
  const startTime = Math.max(0, number(note.startTime, 0));
  const sourceEnd = number(note.endTime, startTime + noteDuration(note, secondsPerBeat));
  const endTime = Math.max(startTime + 0.004, sourceEnd);
  const durationSeconds = endTime - startTime;
  const startBeat = startTime / secondsPerBeat;
  const durationBeats = durationSeconds / secondsPerBeat;
  const beatUnit = 4 / signature.denominator;
  const beatInMeasure = Math.floor((((startBeat % measureBeats) + measureBeats) % measureBeats) / beatUnit) + 1;
  const rawGap = previous ? Math.max(0, startTime - number(previous.endTime, startTime)) : Math.max(0, startTime);
  return {
    ...note,
    startTime: round(startTime),
    endTime: round(endTime),
    noteSeconds: round(durationSeconds),
    durationSeconds: round(durationSeconds),
    beats: round(durationBeats),
    duration: durationDisplay(durationBeats),
    startBeat: round(startBeat),
    durationBeats: round(durationBeats),
    measureIndex: Math.floor(startBeat / measureBeats) + 1,
    beatInMeasure,
    ...noteValue(durationBeats),
    triplet: false,
    restBefore: rawGap >= secondsPerBeat * grid * 0.45 ? round(rawGap) : 0,
    confidence: number(note.confidence, number(note.amplitude, 0))
  };
}

function safeQuantizedTiming(rawStartBeat, rawDurationBeats, candidateStartBeat, candidateDurationBeats, secondsPerBeat, grid, mode) {
  const limits = quantizationGuardrail(mode);
  const maxStartShiftBeats = grid * limits.maxStartShiftGrid;
  const movementBeats = candidateStartBeat - rawStartBeat;
  const durationChangeRatio = Math.abs(candidateDurationBeats - rawDurationBeats) / Math.max(rawDurationBeats, grid * 0.25);
  const startBeat = Math.abs(movementBeats) > maxStartShiftBeats ? rawStartBeat : candidateStartBeat;
  const durationBeats = durationChangeRatio > limits.maxDurationChangeRatio ? rawDurationBeats : candidateDurationBeats;
  return {
    startBeat,
    durationBeats,
    movementMs: round((startBeat - rawStartBeat) * secondsPerBeat * 1000, 3),
    durationChangeRatio: round(Math.abs(durationBeats - rawDurationBeats) / Math.max(rawDurationBeats, 0.001), 6),
    preservedOriginalStart: startBeat === rawStartBeat && candidateStartBeat !== rawStartBeat,
    preservedOriginalDuration: durationBeats === rawDurationBeats && candidateDurationBeats !== rawDurationBeats
  };
}

export function analyzeQuantizationPreview(originalNotes, quantizedNotes, rhythm = {}) {
  const mode = rhythm.quantizationMode || "standard";
  const limits = quantizationGuardrail(mode);
  const source = originalNotes || [];
  const preview = quantizedNotes || [];
  const secondsPerBeat = 60 / clamp(number(rhythm.selectedBpm, 80), 40, 200);
  const noteChanges = source.map((note, index) => {
    const candidate = preview[index] || {};
    const startTime = number(note.startTime);
    const endTime = number(note.endTime, startTime);
    const candidateStart = number(candidate.startTime, startTime);
    const candidateEnd = number(candidate.endTime, candidateStart);
    return {
      index,
      id: note.id || "note-" + index,
      sourceStartTime: round(startTime),
      sourceEndTime: round(endTime),
      previewStartTime: round(candidateStart),
      previewEndTime: round(candidateEnd),
      movementMs: round((candidateStart - startTime) * 1000, 3),
      durationChangeRatio: round(Math.abs((candidateEnd - candidateStart) - (endTime - startTime)) / Math.max(endTime - startTime, 0.001), 6),
      phraseId: note.phraseId,
      restBefore: number(note.restBefore, 0)
    };
  });
  const maxMovementMs = Math.max(0, ...noteChanges.map((note) => Math.abs(note.movementMs)));
  const maxDurationChangeRatio = Math.max(0, ...noteChanges.map((note) => note.durationChangeRatio));
  const sourceTotal = source.length ? number(source[source.length - 1].endTime) - number(source[0].startTime) : 0;
  const previewTotal = preview.length ? number(preview[preview.length - 1].endTime) - number(preview[0].startTime) : 0;
  const totalDurationChangeRatio = sourceTotal > 0 ? Math.abs(previewTotal - sourceTotal) / sourceTotal : 0;
  const orderOrPitchChanged = source.length !== preview.length || source.some((note, index) => note.midi !== preview[index]?.midi || note.phraseId !== preview[index]?.phraseId);
  const phraseBoundaryChanged = source.some((note, index) => Boolean(note.hasBreathBefore) !== Boolean(preview[index]?.hasBreathBefore) || Boolean(note.hasBreathAfter) !== Boolean(preview[index]?.hasBreathAfter));
  const unexpectedOverlap = preview.some((note, index) => {
    if (!index) return false;
    const originalPrevious = source[index - 1];
    const originalOverlap = Math.max(0, number(originalPrevious.endTime) - number(source[index].startTime));
    const previewOverlap = Math.max(0, number(preview[index - 1].endTime) - number(note.startTime));
    return previewOverlap > originalOverlap + Math.min(0.04, secondsPerBeat * 0.08);
  });
  const bpmAmbiguous = rhythm.bpmSource === "detected" && number(rhythm.bpmConfidence, 0) < 0.5 && (rhythm.bpmCandidates || []).some((candidate) => Math.abs(number(candidate) - number(rhythm.selectedBpm) * 2) < 1 || Math.abs(number(candidate) * 2 - number(rhythm.selectedBpm)) < 1);
  const gridBeats = rhythm.quantizationGrid === "sixteenth" ? 0.25 : rhythm.quantizationGrid === "quarter" ? 1 : 0.5;
  const maxAllowedMovementMs = round(secondsPerBeat * gridBeats * limits.maxStartShiftGrid * 1000, 3);
  const blocked = orderOrPitchChanged || phraseBoundaryChanged || unexpectedOverlap || totalDurationChangeRatio > limits.maxTotalDurationChangeRatio || maxMovementMs > maxAllowedMovementMs + 0.001 || maxDurationChangeRatio > limits.maxDurationChangeRatio + 0.001;
  return {
    mode,
    noteChanges,
    maxMovementMs,
    maxAllowedMovementMs,
    maxDurationChangeRatio: round(maxDurationChangeRatio, 6),
    totalDurationChangeRatio: round(totalDurationChangeRatio, 6),
    orderOrPitchChanged,
    phraseBoundaryChanged,
    unexpectedOverlap,
    bpmAmbiguous,
    blocked,
    recommended: !blocked && !bpmAmbiguous
  };
}

function createRests(notes, bpm, signatureValue, grid) {
  const secondsPerBeat = 60 / bpm;
  const measureBeats = getMeasureBeats(signatureValue);
  const rests = [];
  notes.forEach((note, index) => {
    const previous = notes[index - 1];
    if (!previous || note.phraseId === previous.phraseId) return;
    const startTime = number(previous.endTime, 0);
    const endTime = number(note.startTime, startTime);
    const duration = endTime - startTime;
    if (duration < secondsPerBeat * grid * 0.45) return;
    const startBeat = startTime / secondsPerBeat;
    const durationBeats = duration / secondsPerBeat;
    rests.push({
      id: `rest-${index}-${Math.round(startTime * 1000)}`,
      startTime: round(startTime),
      endTime: round(endTime),
      duration: round(duration),
      durationSeconds: round(duration),
      startBeat: round(startBeat),
      durationBeats: round(durationBeats),
      measureIndex: Math.floor(startBeat / measureBeats) + 1,
      phraseAfter: previous.phraseId,
      phraseBefore: note.phraseId,
      isBreathRest: Boolean(previous.hasBreathAfter || note.hasBreathBefore)
    });
  });
  return rests;
}

export function quantizeRhythmNotes(originalNotes, rhythm = {}) {
  const notes = originalNotes.map((note) => ({ ...note })).sort((left, right) => number(left.startTime) - number(right.startTime));
  const bpm = clamp(number(rhythm.selectedBpm, 80), 40, 200);
  const signatureValue = getTimeSignature(rhythm.selectedTimeSignature).value;
  const mode = QUANTIZATION_MODES[rhythm.quantizationMode] || QUANTIZATION_MODES.standard;
  const grid = (QUANTIZATION_GRIDS[rhythm.quantizationGrid] || QUANTIZATION_GRIDS.eighth).beats;
  const secondsPerBeat = 60 / bpm;
  let previous = null;
  const quantizedNotes = notes.map((note, index) => {
    const rawStart = Math.max(0, number(note.startTime));
    const rawDuration = noteDuration(note, secondsPerBeat);
    const rawStartBeat = rawStart / secondsPerBeat;
    const rawDurationBeats = rawDuration / secondsPerBeat;
    let candidateStartBeat = blendToGrid(rawStartBeat, grid, mode.strength);
    let candidateDurationBeats = Math.max(grid * 0.25, blendToGrid(rawDurationBeats, grid, mode.strength));
    const startsNewPhrase = previous && (previous.phraseId !== note.phraseId || previous.hasBreathAfter || note.hasBreathBefore);
    if (startsNewPhrase) candidateStartBeat = rawStartBeat;
    let safe = safeQuantizedTiming(rawStartBeat, rawDurationBeats, candidateStartBeat, candidateDurationBeats, secondsPerBeat, grid, rhythm.quantizationMode || "standard");
    const previousRaw = notes[index - 1];
    const samePhrase = previous && previousRaw && previous.phraseId === note.phraseId && !previous.hasBreathAfter && !note.hasBreathBefore;
    if (samePhrase) {
      const rawGapBeats = Math.max(0, rawStart - number(previousRaw.endTime, rawStart)) / secondsPerBeat;
      const maximumConnectedStart = previous.startBeat + previous.durationBeats + rawGapBeats;
      if (safe.startBeat > maximumConnectedStart) {
        safe = safeQuantizedTiming(rawStartBeat, rawDurationBeats, maximumConnectedStart, safe.durationBeats, secondsPerBeat, grid, rhythm.quantizationMode || "standard");
      }
    }
    const enriched = enrichNote(note, safe, bpm, signatureValue, grid, previous);
    enriched.id = note.id || "rhythm-note-" + index + "-" + Math.round(enriched.startTime * 1000);
    enriched.sourceStartTime = round(rawStart);
    enriched.sourceEndTime = round(rawStart + rawDuration);
    enriched.timingMoveMs = safe.movementMs;
    enriched.durationChangeRatio = safe.durationChangeRatio;
    enriched.quantizationPreservedStart = safe.preservedOriginalStart;
    enriched.quantizationPreservedDuration = safe.preservedOriginalDuration;
    previous = enriched;
    return enriched;
  });
  const totalBeats = quantizedNotes.length
    ? quantizedNotes[quantizedNotes.length - 1].startBeat + quantizedNotes[quantizedNotes.length - 1].durationBeats
    : 0;
  const analysis = analyzeQuantizationPreview(notes, quantizedNotes, { ...rhythm, selectedBpm: bpm });
  return {
    quantizedNotes,
    rests: createRests(quantizedNotes, bpm, signatureValue, grid),
    measures: createMeasures(totalBeats, signatureValue),
    bpm,
    timeSignature: signatureValue,
    totalMeasures: createMeasures(totalBeats, signatureValue).length,
    quantizationMode: rhythm.quantizationMode || "standard",
    quantizationGrid: rhythm.quantizationGrid || "eighth",
    quantizationVersion: RHYTHM_ENGINE_VERSION,
    analysis
  };
}

export function annotateOriginalRhythmNotes(originalNotes, rhythm = {}) {
  const bpm = clamp(number(rhythm.selectedBpm, 80), 40, 200);
  const signatureValue = getTimeSignature(rhythm.selectedTimeSignature).value;
  const grid = (QUANTIZATION_GRIDS[rhythm.quantizationGrid] || QUANTIZATION_GRIDS.eighth).beats;
  let previous = null;
  const notes = originalNotes.map((note, index) => {
    const enriched = annotateOriginalNote(note, bpm, signatureValue, grid, previous);
    enriched.id = note.id || "original-rhythm-" + index + "-" + Math.round(enriched.startTime * 1000);
    previous = enriched;
    return enriched;
  });
  const totalBeats = notes.length ? notes[notes.length - 1].startBeat + notes[notes.length - 1].durationBeats : 0;
  return {
    notes,
    rests: createRests(notes, bpm, signatureValue, grid),
    measures: createMeasures(totalBeats, signatureValue),
    totalMeasures: createMeasures(totalBeats, signatureValue).length
  };
}

export function buildRhythmData(interpretedNotes, options = {}) {
  const metadata = createRhythmMetadata(interpretedNotes, options);
  const original = annotateOriginalRhythmNotes(interpretedNotes, metadata);
  const shouldGeneratePreview = Boolean(options.generateQuantizationPreview) || metadata.quantizationMode !== "original";
  const quantized = shouldGeneratePreview
    ? quantizeRhythmNotes(original.notes, { ...metadata, quantizationMode: metadata.quantizationMode })
    : { quantizedNotes: [], rests: [], measures: [], totalMeasures: original.totalMeasures, analysis: null, quantizationVersion: RHYTHM_ENGINE_VERSION };
  return {
    ...metadata,
    originalRhythmNotes: original.notes,
    originalRests: original.rests,
    originalMeasures: original.measures,
    quantizedNotes: quantized.quantizedNotes,
    quantizedRests: quantized.rests,
    quantizedMeasures: quantized.measures,
    quantizationDiagnostics: quantized.analysis || metadata.quantizationDiagnostics || null,
    quantizationPreviewStatus: shouldGeneratePreview ? (quantized.analysis?.blocked ? "blocked" : "ready") : "idle",
    totalMeasures: original.totalMeasures,
    lastRhythmAction: null,
    previousRhythmVersion: null,
    rhythmUpdatedAt: new Date().toISOString()
  };
}

export function createRhythmExport({ notes, rhythm, title }) {
  const activeNotes = notes.map((note) => ({
    midi: note.midi,
    pitchName: note.pitchName,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    startTime: note.startTime,
    endTime: note.endTime,
    duration: note.durationSeconds ?? note.noteSeconds,
    measureIndex: note.measureIndex,
    beatInMeasure: note.beatInMeasure,
    noteValue: note.noteValue,
    dotted: Boolean(note.dotted),
    triplet: Boolean(note.triplet),
    phraseId: note.phraseId,
    restBefore: note.restBefore || 0,
    confidence: note.confidence ?? null
  }));
  return {
    format: "hummely-rhythm-v1",
    title,
    bpm: rhythm.selectedBpm,
    timeSignature: rhythm.selectedTimeSignature,
    pickupBeats: rhythm.pickupBeats || 0,
    totalMeasures: rhythm.totalMeasures || 0,
    rhythmSource: rhythm.rhythmSource,
    quantizationMode: rhythm.quantizationMode,
    melodyVersion: RHYTHM_ENGINE_VERSION,
    notes: activeNotes
  };
}
