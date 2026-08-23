import assert from "node:assert/strict";
import {
  applyArticulationBoundariesToStableNotes,
  recoverFastRunFromFramePitchTrack,
  stabilizeSegmentPitchesFromFrameTrack
} from "../src/basicPitchTranscriber.js";
import { interpretHummingMelody } from "../src/hummingMelodyInterpreter.js";
import { VOICE_RECOGNITION_CONFIG } from "../src/voiceRecognitionConfig.js";

function note(midi, startTime, duration, overrides = {}) {
  return {
    id: overrides.id || "note-" + startTime,
    midi,
    pitchName: "C4",
    frequency: 440 * 2 ** ((midi - 69) / 12),
    startTime,
    endTime: startTime + duration,
    duration,
    amplitude: 0.7,
    onsetConfidence: 0.38,
    phraseId: "phrase-1",
    phraseStart: 0,
    phraseEnd: startTime + duration,
    hasBreathBefore: false,
    hasBreathAfter: false,
    processing: { status: "interpreted", reason: "baseline", mergedInto: null },
    ...overrides
  };
}

function midis(notes) {
  return notes.map((item) => item.midi);
}

function event(startTime, options = {}) {
  return {
    id: options.id || "art-" + startTime,
    time: startTime,
    startTime,
    articulationOnsetScore: options.score ?? 0.82,
    energyRise: options.energyRise ?? 2.1,
    energyValleyRatio: options.energyValleyRatio ?? 0.42,
    spectralFlux: options.spectralFlux ?? 2,
    basicPitchOnset: options.basicPitchOnset ?? 0.34,
    sources: options.sources || ["energy-attack", "spectral-flux"],
    peakCount: options.peakCount ?? 1,
    rawPeakIds: options.rawPeakIds || [],
    isIndependentReattack: Boolean(options.independent),
    independentEnergyReset: Boolean(options.independent),
    modelTransient: Boolean(options.modelTransient),
    canSplitStableNote: Boolean(options.independent),
    reason: options.independent ? "independent-rearticulation" : "clustered-single-articulation"
  };
}

function split(noteInput, events) {
  return applyArticulationBoundariesToStableNotes([noteInput], { articulationEvents: events }, VOICE_RECOGNITION_CONFIG).notes;
}

const held = split(note(60, 0, 5), [event(0.04)]);
assert.deepEqual(midis(held), [60], "a five-second held C4 remains one note");

const slowTwo = split(note(60, 0, 1), [event(0.04), event(0.11), event(0.5, { independent: true, peakCount: 2 })]);
assert.deepEqual(midis(slowTwo), [60, 60], "slow la la is exactly two C4 notes despite initial multi-peak detail");

const fastTwo = split(note(65, 0, 0.16), [event(0.068, { independent: true, modelTransient: true })]);
assert.deepEqual(midis(fastTwo), [65, 65], "fast F4-F4 can split without silence");

const fastFour = split(note(60, 0, 0.24), [
  event(0.06, { independent: true, modelTransient: true }),
  event(0.12, { independent: true, modelTransient: true }),
  event(0.18, { independent: true, modelTransient: true })
]);
assert.deepEqual(midis(fastFour), [60, 60, 60, 60], "fast four same-pitch syllables remain four notes");

const slowFour = split(note(60, 0, 1), [
  event(0.25, { independent: true }), event(0.5, { independent: true }), event(0.75, { independent: true })
]);
assert.deepEqual(midis(slowFour), [60, 60, 60, 60], "slow four same-pitch syllables retain one inherited MIDI");

const firstNoteGlide = split(note(60, 0, 0.42), [event(0.035), event(0.09, { peakCount: 2 })]);
assert.deepEqual(midis(firstNoteGlide), [60], "initial glide and vowel entrance cannot split the first note");

const stableRawMelody = [
  note(60, 0, 0.16), note(62, 0.165, 0.16), note(64, 0.33, 0.16), note(65, 0.495, 0.16)
];
const baselineMelody = interpretHummingMelody(stableRawMelody, { config: VOICE_RECOGNITION_CONFIG }).interpretedNotes;
assert.deepEqual(midis(baselineMelody), [60, 62, 64, 65], "slow distinct melody keeps stable Basic Pitch MIDI");

const vibrato = interpretHummingMelody([
  note(60, 0, 0.22), note(61, 0.225, 0.1, { onsetConfidence: 0.08 }), note(60, 0.33, 0.24, { onsetConfidence: 0.08 })
], { config: VOICE_RECOGNITION_CONFIG }).interpretedNotes;
assert.deepEqual(midis(vibrato), [60], "vibrato remains one centre pitch");

const fourPotentiallyWrong = [0, 1, 2, 3].map((index) => note(index % 2 ? 61 : 60, index * 0.2, 0.2));
const sameC4Track = [0, 1, 2, 3].flatMap((section) =>
  [0.06, 0.1, 0.14].map((offset) => ({ midi: 60, confidence: 0.84, valid: true, time: section * 0.2 + offset }))
);
const stabilized = stabilizeSegmentPitchesFromFrameTrack(fourPotentiallyWrong, sameC4Track);
assert.deepEqual(midis(stabilized.notes), [60, 60, 60, 60], "only stable vowel frame centres may correct an unstable attack MIDI");

const underCounted = [note(60, 0, 0.2), note(65, 0.2, 0.3)];
const framePitchTrack = [60, 62, 64, 65].flatMap((midi, section) =>
  Array.from({ length: 4 }, (_, frame) => ({
    midi,
    confidence: 0.82,
    valid: true,
    time: Number((section * 0.08 + frame * (256 / 22050)).toFixed(6))
  }))
);
const recovered = recoverFastRunFromFramePitchTrack(underCounted, framePitchTrack);
assert.deepEqual(midis(recovered.notes), [60, 62, 64, 65], "high-confidence frame centres recover a missed four-note fast run");
assert.equal(recovered.decision?.pitchSource, "basic-pitch-frame-track", "fast-run recovery reports a pitch-only source");

console.log(JSON.stringify({
  status: "passed",
  slowTwo: midis(slowTwo),
  fastTwo: midis(fastTwo),
  fastFour: midis(fastFour),
  slowFour: midis(slowFour),
  stabilizedSlowFour: midis(stabilized.notes),
  baselineMidis: midis(baselineMelody),
  recoveredFastRun: midis(recovered.notes)
}, null, 2));
