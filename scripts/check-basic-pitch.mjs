import { BasicPitch, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";
import { selectMonophonicNotes } from "../src/basicPitchTranscriber.js";
import { interpretHummingMelody } from "../src/hummingMelodyInterpreter.js";
import { VOICE_RECOGNITION_CONFIG } from "../src/voiceRecognitionConfig.js";

const sampleRate = 22050;
const modelUrl = "http://127.0.0.1:5173/basic-pitch/model.json";

function createMelodySamples(midis, noteSeconds, gapSeconds) {
  const totalSamples = Math.round(midis.length * (noteSeconds + gapSeconds) * sampleRate);
  const samples = new Float32Array(totalSamples);
  let cursor = 0;

  midis.forEach((midi) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const noteSamples = Math.round(noteSeconds * sampleRate);
    for (let index = 0; index < noteSamples; index += 1) {
      const envelope = Math.max(0, Math.min(1, index / 180, (noteSamples - index) / 180));
      samples[cursor + index] = Math.sin((Math.PI * 2 * frequency * index) / sampleRate) * envelope * 0.24;
    }
    cursor += noteSamples + Math.round(gapSeconds * sampleRate);
  });

  return samples;
}

async function recognize(samples) {
  const transcriber = new BasicPitch(modelUrl);
  const frames = [];
  const onsets = [];
  const contours = [];
  await transcriber.evaluateModel(samples, (frameBatch, onsetBatch, contourBatch) => {
    frames.push(...frameBatch);
    onsets.push(...onsetBatch);
    contours.push(...contourBatch);
  }, () => {});
  const config = VOICE_RECOGNITION_CONFIG.basicPitch;
  return selectMonophonicNotes(noteFramesToTime(
    outputToNotesPoly(
      frames,
      onsets,
      config.onsetThreshold,
      config.frameThreshold,
      config.minimumNoteFrames,
      config.inferOnsets,
      config.maximumFrequency,
      config.minimumFrequency,
      false,
      config.energyToleranceFrames
    )
  )).map((note) => note.midi);
}

const cases = [
  { name: "稳定音阶 C4-D4-E4-F4", expected: [60, 62, 64, 65], samples: createMelodySamples([60, 62, 64, 65], 0.42, 0.09) },
  { name: "重复音 C4-C4-D4-C4（连贯优先）", expected: [60, 62, 60], samples: createMelodySamples([60, 60, 62, 60], 0.35, 0.12) },
  { name: "静音", expected: [], samples: new Float32Array(sampleRate * 2) }
];

for (const item of cases) {
  const actual = await recognize(item.samples);
  const pass = actual.join(",") === item.expected.join(",");
  console.log(`${item.name}\n  expected: ${item.expected.join(", ") || "(none)"}\n  actual:   ${actual.join(", ") || "(none)"}\n  ${pass ? "PASS" : "CHECK"}`);
  if (!pass) process.exitCode = 1;
}

const fragmentResult = selectMonophonicNotes([
  { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 0.8, onsetConfidence: 0.55 },
  { pitchMidi: 60, startTimeSeconds: 0.52, durationSeconds: 0.12, amplitude: 0.34, onsetConfidence: 0.05 }
]);
const fragmentPass = fragmentResult.length === 1 && fragmentResult[0].duration >= 0.63;
console.log(`尾音碎片合并\n  expected: 1 note (>=0.63s)\n  actual:   ${fragmentResult.length} note (${fragmentResult[0]?.duration?.toFixed(2) || "0"}s)\n  ${fragmentPass ? "PASS" : "CHECK"}`);
if (!fragmentPass) process.exitCode = 1;

const reattackResult = selectMonophonicNotes([
  { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.3, amplitude: 0.8, onsetConfidence: 0.55 },
  { pitchMidi: 60, startTimeSeconds: 0.33, durationSeconds: 0.3, amplitude: 0.8, onsetConfidence: 0.72 }
]);
const reattackPass = reattackResult.length === 1;
console.log(`无气口重复同音默认合并\n  expected: 1 note\n  actual:   ${reattackResult.length} notes\n  ${reattackPass ? "PASS" : "CHECK"}`);
if (!reattackPass) process.exitCode = 1;

const repeatedC4 = selectMonophonicNotes([0, 1, 2, 3].map((index) => ({
  pitchMidi: 60,
  startTimeSeconds: index * 0.38,
  durationSeconds: 0.28,
  amplitude: 0.78,
  onsetConfidence: 0.71
})));
const repeatedC4Pass = repeatedC4.length === 1;
console.log(`无气口四次 C4 默认合并\n  expected: 1 note\n  actual:   ${repeatedC4.length} notes\n  ${repeatedC4Pass ? "PASS" : "CHECK"}`);
if (!repeatedC4Pass) process.exitCode = 1;

const pausedC4 = selectMonophonicNotes([
  { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.32, amplitude: 0.8, onsetConfidence: 0.6 },
  { pitchMidi: 60, startTimeSeconds: 0.58, durationSeconds: 0.32, amplitude: 0.76, onsetConfidence: 0.62 }
]);
const pausedC4Pass = pausedC4.length === 2;
console.log(`C4 停顿后重唱\n  expected: 2 notes\n  actual:   ${pausedC4.length} notes\n  ${pausedC4Pass ? "PASS" : "CHECK"}`);
if (!pausedC4Pass) process.exitCode = 1;

const terminalReattack = selectMonophonicNotes([
  { pitchMidi: 65, startTimeSeconds: 0, durationSeconds: 0.4, amplitude: 0.82, onsetConfidence: 0.6 },
  { pitchMidi: 65, startTimeSeconds: 0.43, durationSeconds: 0.26, amplitude: 0.79, onsetConfidence: 0.7 }
]);
const terminalReattackPass = terminalReattack.length === 1;
console.log(`无气口结尾同音默认合并\n  expected: 1 note\n  actual:   ${terminalReattack.length} notes\n  ${terminalReattackPass ? "PASS" : "CHECK"}`);
if (!terminalReattackPass) process.exitCode = 1;

function rawEvent(midi, startTime, duration, options = {}) {
  return {
    id: options.id || `raw-${startTime}`,
    midi,
    startTime,
    endTime: startTime + duration,
    duration,
    amplitude: options.amplitude ?? 0.74,
    onsetConfidence: options.onsetConfidence ?? 0.06,
    preEnergy: options.preEnergy ?? 0.03,
    attackEnergy: options.attackEnergy ?? 0.04,
    energyRise: options.energyRise ?? 1.1
  };
}

function assertInterpreted(name, events, expectedMidis, mode = "standard") {
  const result = interpretHummingMelody(events, { mode });
  const actualMidis = result.interpretedNotes.map((note) => note.midi);
  const pass = actualMidis.join(",") === expectedMidis.join(",");
  console.log(`${name}\n  expected: ${expectedMidis.join(", ") || "(none)"}\n  actual:   ${actualMidis.join(", ") || "(none)"}\n  ${pass ? "PASS" : "CHECK"}`);
  if (!pass) process.exitCode = 1;
  return result;
}

assertInterpreted("真人自然颤音长 C4", [
  rawEvent(60, 0, 0.22), rawEvent(61, 0.225, 0.11, { amplitude: 0.61 }),
  rawEvent(60, 0.34, 0.13), rawEvent(59, 0.475, 0.1, { amplitude: 0.58 }),
  rawEvent(60, 0.58, 0.23)
], [60]);

assertInterpreted("C4 附近轻微漂移", [
  rawEvent(60, 0, 0.22), rawEvent(61, 0.225, 0.13, { amplitude: 0.65 }),
  rawEvent(60, 0.36, 0.24)
], [60]);

assertInterpreted("C4 滑入并稳定到 D4", [
  rawEvent(60, 0, 0.42), rawEvent(61, 0.43, 0.08, { amplitude: 0.63 }),
  rawEvent(62, 0.515, 0.35, { amplitude: 0.79 })
], [60, 62]);

assertInterpreted("自然收音不会产生尾音碎片", [
  rawEvent(64, 0, 0.46, { amplitude: 0.82, onsetConfidence: 0.52 }),
  rawEvent(64, 0.47, 0.13, { amplitude: 0.39 }),
  rawEvent(63, 0.605, 0.1, { amplitude: 0.25 })
], [64]);

assertInterpreted("四次明确重新哼唱 C4", [0, 1, 2, 3].map((index) => rawEvent(60, index * 0.42, 0.29, {
  onsetConfidence: 0.74, amplitude: 0.78, preEnergy: 0.01, attackEnergy: 0.12, energyRise: 2.4
})), [60, 60, 60, 60]);

assertInterpreted("静音不会产生音符", [], []);

const modeFixture = [
  rawEvent(60, 0, 0.48, { amplitude: 0.85 }),
  rawEvent(61, 0.345, 0.22, { amplitude: 0.68 }),
  rawEvent(61, 0.57, 0.22, { amplitude: 0.71 })
];
const smoothMode = interpretHummingMelody(modeFixture, { mode: "smooth" }).interpretedNotes.map((note) => note.midi);
const standardMode = interpretHummingMelody(modeFixture, { mode: "standard" }).interpretedNotes.map((note) => note.midi);
const detailedMode = interpretHummingMelody(modeFixture, { mode: "detailed" }).interpretedNotes.map((note) => note.midi);
const modePass = smoothMode.join(",") === "60" && standardMode.join(",") === "60,61" && detailedMode.join(",") === "60,61";
console.log(`识别精细度三档\n  平滑: ${smoothMode.join(", ")}\n  标准: ${standardMode.join(", ")}\n  精细: ${detailedMode.join(", ")}\n  ${modePass ? "PASS" : "CHECK"}`);
if (!modePass) process.exitCode = 1;

function assertPhrases(name, events, expectedMidis, expectedPhrases, silenceGaps = []) {
  const result = interpretHummingMelody(events, { silenceGaps });
  const midis = result.interpretedNotes.map((note) => note.midi);
  const phraseIds = [...new Set(result.interpretedNotes.map((note) => note.phraseId))];
  const flagsArePresent = result.interpretedNotes.every((note) =>
    typeof note.phraseId === "string" && Number.isFinite(note.phraseStart) && Number.isFinite(note.phraseEnd) &&
    typeof note.hasBreathBefore === "boolean" && typeof note.hasBreathAfter === "boolean"
  );
  const pass = midis.join(",") === expectedMidis.join(",") && phraseIds.length === expectedPhrases && flagsArePresent;
  console.log(`${name}\n  expected: ${expectedMidis.join(", ")} in ${expectedPhrases} phrase(s)\n  actual:   ${midis.join(", ")} in ${phraseIds.length} phrase(s)\n  ${pass ? "PASS" : "CHECK"}`);
  if (!pass) process.exitCode = 1;
}

assertPhrases("持续 C4 的同音碎片合并", [
  rawEvent(60, 0, 0.22), rawEvent(60, 0.23, 0.18, { onsetConfidence: 0.72 }), rawEvent(60, 0.42, 0.21, { onsetConfidence: 0.71 })
], [60], 1);

assertPhrases("同一口气 C4-D4-E4-F4", [
  rawEvent(60, 0, 0.3), rawEvent(62, 0.31, 0.3), rawEvent(64, 0.62, 0.3), rawEvent(65, 0.93, 0.3)
], [60, 62, 64, 65], 1);

assertPhrases("短暂检测丢帧不形成气口", [
  rawEvent(60, 0, 0.28), rawEvent(62, 0.43, 0.28)
], [60, 62], 1);

assertPhrases("持续静音后形成两个乐句", [
  rawEvent(60, 0, 0.3), rawEvent(62, 0.8, 0.3)
], [60, 62], 2, [{
  startTime: 0.3,
  endTime: 0.8,
  duration: 0.5,
  frames: Array.from({ length: 16 }, () => ({ rms: 0.001 }))
}]);
