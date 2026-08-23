import assert from "node:assert/strict";
import { clusterArticulationCandidates, analyzeVocalArticulation, articulationEvidenceNear } from "../src/vocalArticulationAnalyzer.js";
import { interpretHummingMelody } from "../src/hummingMelodyInterpreter.js";
import { applyArticulationBoundariesToStableNotes } from "../src/basicPitchTranscriber.js";
import { VOICE_RECOGNITION_CONFIG } from "../src/voiceRecognitionConfig.js";

const sampleRate = 22050;

function createRearticulatedTone(count, { midi = 60, noteSeconds = 0.26, valleySeconds = 0.018 } = {}) {
  const samples = new Float32Array(Math.ceil(count * noteSeconds * sampleRate));
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const within = time % noteSeconds;
    const attack = Math.min(1, within / 0.012);
    const release = within > noteSeconds - valleySeconds ? 0.12 : 1;
    samples[index] = Math.sin(Math.PI * 2 * frequency * time) * 0.24 * Math.max(0.1, attack) * release;
  }
  return samples;
}

function createHeldTone(seconds = 0.8, midi = 60) {
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(Math.PI * 2 * frequency * index / sampleRate) * 0.2;
  return samples;
}

function peak(id, time, options = {}) {
  return {
    id,
    time,
    articulationOnsetScore: 0.8,
    energyRise: options.energyRise ?? 2.1,
    energyValleyRatio: options.energyValleyRatio ?? 0.42,
    spectralFlux: 2,
    basicPitchOnset: options.basicPitchOnset ?? 0.3,
    nonPeriodicChange: 0.3,
    sources: ["energy-attack", "spectral-flux"],
    independentEnergyReset: Boolean(options.independent),
    modelTransient: Boolean(options.modelTransient),
    reason: "audio-attack"
  };
}

function event(midi, startTime, duration, evidence = null, onsetConfidence = 0.08) {
  return {
    id: "event-" + startTime,
    midi,
    startTime,
    endTime: startTime + duration,
    duration,
    amplitude: 0.72,
    onsetConfidence,
    preEnergy: evidence ? 0.03 : 0.08,
    attackEnergy: evidence ? 0.11 : 0.08,
    energyRise: evidence ? evidence.energyRise : 1.02,
    articulationOnsetScore: evidence?.articulationOnsetScore || 0,
    articulationEvidence: evidence
  };
}

function interpretedMidis(events) {
  return interpretHummingMelody(events, { config: VOICE_RECOGNITION_CONFIG }).interpretedNotes.map((note) => note.midi);
}

const oneSyllable = clusterArticulationCandidates([
  peak("attack", 0.1, { independent: true }),
  peak("vowel", 0.14)
], VOICE_RECOGNITION_CONFIG);
assert.equal(oneSyllable.length, 1, "attack and vowel-entry peaks from one la cluster together");
assert.equal(oneSyllable[0].peakCount, 2, "cluster retains both source peaks for diagnostics");

const fastTwo = clusterArticulationCandidates([
  peak("first", 0.1),
  peak("second", 0.165, { independent: true, modelTransient: true })
], VOICE_RECOGNITION_CONFIG);
assert.equal(fastTwo.length, 2, "two rapid independent la attacks remain two events");
assert.equal(fastTwo[1].canSplitStableNote, true, "second fast attack can split a stable note");


function stableNote(midi, duration) {
  return {
    id: "stable-" + duration,
    midi,
    pitchName: "C4",
    frequency: 440 * 2 ** ((midi - 69) / 12),
    startTime: 0,
    endTime: duration,
    duration,
    amplitude: 0.78,
    onsetConfidence: 0.42,
    phraseId: "phrase-1",
    phraseStart: 0,
    phraseEnd: duration,
    hasBreathBefore: false,
    hasBreathAfter: false,
    processing: { status: "interpreted", reason: "fixture", mergedInto: null }
  };
}

const fastAudio = analyzeVocalArticulation(createRearticulatedTone(4, { noteSeconds: 0.08, valleySeconds: 0.012 }), { sampleRate, config: VOICE_RECOGNITION_CONFIG });
const fastAudioSplit = applyArticulationBoundariesToStableNotes([stableNote(60, 0.32)], fastAudio, VOICE_RECOGNITION_CONFIG).notes;
assert.deepEqual(fastAudioSplit.map((note) => note.midi), [60, 60, 60, 60], "80ms same-pitch syllables retain four notes from raw audio events");

const slowAudio = analyzeVocalArticulation(createRearticulatedTone(4, { noteSeconds: 0.26, valleySeconds: 0.018 }), { sampleRate, config: VOICE_RECOGNITION_CONFIG });
const slowAudioSplit = applyArticulationBoundariesToStableNotes([stableNote(60, 1.04)], slowAudio, VOICE_RECOGNITION_CONFIG).notes;
assert.deepEqual(slowAudioSplit.map((note) => note.midi), [60, 60, 60, 60], "slow same-pitch syllables retain four notes after peak clustering");

const held = analyzeVocalArticulation(createHeldTone(), { sampleRate, config: VOICE_RECOGNITION_CONFIG });
assert.equal(held.articulationEvents.filter((candidate) => candidate.time > 0.08).length, 0, "a held vowel must not create internal articulation events");

const twoAnalysis = analyzeVocalArticulation(createRearticulatedTone(2), { sampleRate, config: VOICE_RECOGNITION_CONFIG });
const secondEvidence = articulationEvidenceNear(0.26, twoAnalysis, 0.07);
assert.ok(secondEvidence?.isIndependentReattack, "a second syllable must carry independent re-attack evidence");
assert.deepEqual(interpretedMidis([
  event(60, 0, 0.25), event(60, 0.26, 0.25, secondEvidence, 0.3)
]), [60, 60], "嗯嗯: same pitch with a re-attack remains two notes");

const fourAnalysis = analyzeVocalArticulation(createRearticulatedTone(4), { sampleRate, config: VOICE_RECOGNITION_CONFIG });
const repeatedC4 = [0, 1, 2, 3].map((index) => event(60, index * 0.26, 0.25, index ? articulationEvidenceNear(index * 0.26, fourAnalysis, 0.07) : null, 0.28));
assert.deepEqual(interpretedMidis(repeatedC4), [60, 60, 60, 60], "啦啦啦啦: four re-attacks remain four notes");

const vibrato = [event(60, 0, 0.22), event(61, 0.225, 0.1, null, 0.08), event(60, 0.33, 0.24, null, 0.08)];
assert.deepEqual(interpretedMidis(vibrato), [60], "natural vibrato stays one note");

const tail = [event(60, 0, 0.46), { ...event(60, 0.47, 0.14), amplitude: 0.25 }];
assert.deepEqual(interpretedMidis(tail), [60], "a decaying tail must not become another note");

const noise = new Float32Array(sampleRate * 0.5).map(() => (Math.random() - 0.5) * 0.003);
const noiseAnalysis = analyzeVocalArticulation(noise, { sampleRate, config: VOICE_RECOGNITION_CONFIG });
assert.equal(noiseAnalysis.articulationEvents.length, 0, "low background noise must not create an articulation event");

console.log(JSON.stringify({
  status: "passed",
  clusteredOneLaPeaks: oneSyllable[0].rawPeakIds,
  rapidEvents: fastTwo.map((item) => item.id),
  fastAudioEvents: fastAudio.articulationEvents.length,
  fastAudioNotes: fastAudioSplit.length,
  slowAudioNotes: slowAudioSplit.length,
  reattackScore: secondEvidence.articulationOnsetScore,
  repeatedSamePitch: interpretedMidis(repeatedC4)
}, null, 2));
