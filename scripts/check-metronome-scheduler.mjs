import assert from "node:assert/strict";
import { MetronomeScheduler } from "../src/metronomeScheduler.js";
import { DEFAULT_METRONOME_SETTINGS, METRONOME_SOUND_PRESETS } from "../src/rhythmConfig.js";

global.window = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {}
};

const context = { currentTime: 0, state: "running" };
const intervals = [60, 80, 100].map((bpm) => {
  const scheduler = new MetronomeScheduler(context, {
    bpm,
    timeSignature: "4/4",
    cueMode: { audio: false, visual: true, vibrate: false },
    volume: 0.4
  });
  const interval = scheduler.secondsPerBeat();
  scheduler.stop();
  return { bpm, intervalSeconds: interval };
});

assert.deepEqual(intervals, [
  { bpm: 60, intervalSeconds: 1 },
  { bpm: 80, intervalSeconds: 0.75 },
  { bpm: 100, intervalSeconds: 0.6 }
]);

assert.equal(DEFAULT_METRONOME_SETTINGS.bpm, 80);
assert.equal(DEFAULT_METRONOME_SETTINGS.soundPreset, "warmWood");
assert.equal(Object.keys(METRONOME_SOUND_PRESETS).length, 3);
Object.values(METRONOME_SOUND_PRESETS).forEach((preset) => {
  assert.ok(preset.frequencies.every((frequency) => frequency < 800), "soft candidates avoid alert-like high frequencies");
  assert.ok(preset.attackSeconds > 0 && preset.decaySeconds < 0.08, "clicks use short anti-pop envelopes");
  assert.ok(preset.downbeatGain <= 1.12, "downbeats remain gentle");
});

for (const { bpm, intervalSeconds } of intervals) {
  const startTime = 0.1;
  const beatCount = Math.floor(60 / intervalSeconds);
  const finalBeatTime = startTime + beatCount * intervalSeconds;
  const expectedTime = startTime + 60;
  assert.ok(Math.abs(finalBeatTime - expectedTime) < 1e-9, `${bpm} BPM must not accumulate a one-minute scheduling offset`);
}

const calls = [];
const scheduler = new MetronomeScheduler(context, {
  bpm: 80,
  timeSignature: "3/4",
  cueMode: { audio: false, visual: true, vibrate: false },
  volume: 0.4
});
scheduler.start({ startTime: 0.1, onBeat: (beat) => calls.push(beat) });
const scheduledFirstBeat = scheduler.getDiagnostics()[0];
assert.equal(scheduledFirstBeat.beatIndex, 0);
assert.equal(scheduledFirstBeat.measureIndex, 0);
assert.equal(scheduledFirstBeat.isDownbeat, true);
assert.equal(scheduledFirstBeat.actualBeatTime, null);
scheduler.stop();

console.log(JSON.stringify({ status: "passed", intervals, scheduledFirstBeat }, null, 2));
