import assert from "node:assert/strict";
import { createLivePitchDisplayState, createRealtimePitchTracker } from "../src/realtimePitch.js";

const sampleRate = 44100;
const frameLength = 2048;

function sine(frequency, amplitude = 0.2) {
  const samples = new Float32Array(frameLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return samples;
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

for (const target of [48, 55, 60, 62, 67, 72]) {
  const tracker = createRealtimePitchTracker(frameLength);
  let detected = null;
  for (let pass = 0; pass < 5; pass += 1) detected = tracker.detect(sine(midiToFrequency(target)), sampleRate) || detected;
  assert.equal(detected?.midi, target, "MIDI " + target + " should display");
}

const state = createLivePitchDisplayState({ silenceConfirmSeconds: 0.75 });
state.update({ voiced: true, pitch: { midi: 60, frequency: midiToFrequency(60) }, durationSeconds: 0.05 });
for (let frame = 0; frame < 100; frame += 1) {
  const displayed = state.update({ voiced: true, pitch: null, durationSeconds: 0.05 });
  assert.equal(displayed?.midi, 60, "five seconds of voiced-but-unreliable pitch must retain C4");
  assert.equal(displayed?.pitchReliable, false, "held label records unreliable pitch without treating it as silence");
}
assert.equal(state.update({ voiced: false, durationSeconds: 0.35 })?.midi, 60, "brief silence keeps label");
assert.equal(state.update({ voiced: false, durationSeconds: 0.45 }), null, "confirmed silence clears label");

const sustained = createRealtimePitchTracker(frameLength);
const sustainedFrames = Math.ceil(5 / (frameLength / sampleRate));
let last = null;
for (let pass = 0; pass < sustainedFrames; pass += 1) {
  const cents = pass % 2 ? 11 : -9;
  const frequency = midiToFrequency(60) * 2 ** (cents / 1200);
  last = sustained.detect(sine(frequency), sampleRate) || last;
}
assert.equal(last?.midi, 60, "five-second tracker C4 remains visible");

const silentTracker = createRealtimePitchTracker(frameLength);
assert.equal(silentTracker.detect(new Float32Array(frameLength), sampleRate), null, "initial silence has no label");

console.log(JSON.stringify({
  status: "passed",
  sustainedSeconds: Number((sustainedFrames * frameLength / sampleRate).toFixed(2)),
  stateMachine: ["voiced", "pitch-unreliable-held", "confirmed-silence-cleared"]
}, null, 2));
