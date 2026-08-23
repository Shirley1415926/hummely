import assert from "node:assert/strict";
import { buildRhythmData, createRhythmExport, quantizeRhythmNotes } from "../src/rhythmEngine.js";

const phraseNotes = [
  { midi: 60, pitchName: "C4", startTime: 0, endTime: 0.62, noteSeconds: 0.62, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: false, confidence: 0.9 },
  { midi: 62, pitchName: "D4", startTime: 0.64, endTime: 1.17, noteSeconds: 0.53, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: true, confidence: 0.85 },
  { midi: 64, pitchName: "E4", startTime: 1.58, endTime: 2.1, noteSeconds: 0.52, phraseId: "phrase-2", hasBreathBefore: true, hasBreathAfter: false, confidence: 0.82 },
  { midi: 65, pitchName: "F4", startTime: 2.11, endTime: 2.45, noteSeconds: 0.34, phraseId: "phrase-2", hasBreathBefore: false, hasBreathAfter: true, confidence: 0.8 }
];

const rhythm = buildRhythmData(phraseNotes, {
  selectedBpm: 120,
  selectedTimeSignature: "4/4",
  quantizationMode: "standard",
  quantizationGrid: "eighth",
  generateQuantizationPreview: true
});

const naturalRhythm = buildRhythmData([
  { midi: 60, pitchName: "C4", startTime: 0.03, endTime: 0.12, noteSeconds: 0.09, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: false },
  { midi: 62, pitchName: "D4", startTime: 0.18, endTime: 0.71, noteSeconds: 0.53, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: true },
  { midi: 64, pitchName: "E4", startTime: 1.37, endTime: 1.58, noteSeconds: 0.21, phraseId: "phrase-2", hasBreathBefore: true, hasBreathAfter: false }
], {
  selectedBpm: 80,
  selectedTimeSignature: "4/4",
  quantizationMode: "original",
  quantizationGrid: "eighth",
  rhythmSource: "original",
  quantizationEnabled: false
});
assert.equal(naturalRhythm.rhythmSource, "original", "original is the default formal source");
assert.equal(naturalRhythm.quantizationEnabled, false, "a natural result is never silently quantized");
assert.equal(naturalRhythm.quantizedNotes.length, 0, "no preview is generated until requested");
assert.deepEqual(
  naturalRhythm.originalRhythmNotes.map((note) => [note.startTime, note.endTime, note.noteSeconds]),
  [[0.03, 0.12, 0.09], [0.18, 0.71, 0.53], [1.37, 1.58, 0.21]],
  "original annotation must preserve every recorded timestamp, including a short 90ms note"
);

assert.equal(rhythm.originalRhythmNotes.length, phraseNotes.length, "original rhythm must retain every note");
assert.equal(rhythm.quantizedNotes.length, phraseNotes.length, "quantization must not delete notes");
assert.deepEqual(rhythm.quantizedNotes.map((note) => note.midi), phraseNotes.map((note) => note.midi), "quantization must not alter pitch order");
assert.ok(rhythm.quantizedNotes.every((note) => note.endTime > note.startTime && note.startBeat >= 0), "every quantized note needs a positive duration");
assert.ok(rhythm.quantizedNotes.every((note) => Number.isFinite(note.measureIndex) && Number.isFinite(note.durationBeats)), "AI-ready rhythm fields must be present");
assert.ok(rhythm.quantizedRests.some((rest) => rest.isBreathRest), "a deliberate phrase break must remain a rest");

const stronger = quantizeRhythmNotes(rhythm.originalRhythmNotes, {
  selectedBpm: 120,
  selectedTimeSignature: "6/8",
  quantizationMode: "strong",
  quantizationGrid: "sixteenth"
});
assert.equal(stronger.timeSignature, "6/8");
assert.ok(stronger.quantizedNotes.every((note, index, values) => {
  if (!index || note.phraseId !== values[index - 1].phraseId) return true;
  const rawGap = Math.max(0, phraseNotes[index].startTime - phraseNotes[index - 1].endTime);
  const previewGap = Math.max(0, note.startTime - values[index - 1].endTime);
  return previewGap <= rawGap + 0.001;
}), "quantization must not enlarge a same-phrase gap beyond the recorded timing");

const exported = createRhythmExport({ title: "回归旋律", notes: stronger.quantizedNotes, rhythm: { ...rhythm, selectedBpm: 120, selectedTimeSignature: "6/8", rhythmSource: "quantized" } });
assert.equal(exported.format, "hummely-rhythm-v1");
assert.equal(exported.notes.length, phraseNotes.length);
assert.ok(exported.notes.every((note) => "phraseId" in note && "startBeat" in note && "durationBeats" in note));

console.log(JSON.stringify({
  status: "passed",
  originalNotes: rhythm.originalRhythmNotes.length,
  quantizedNotes: stronger.quantizedNotes.length,
  breaths: stronger.rests.length,
  exportedFields: Object.keys(exported.notes[0])
}, null, 2));
