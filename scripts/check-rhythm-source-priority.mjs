import assert from "node:assert/strict";
import { annotateOriginalRhythmNotes, buildRhythmData, quantizeRhythmNotes } from "../src/rhythmEngine.js";
import { createPhrasePlaybackPlan } from "../src/phrasePlaybackPlan.js";

const original = [
  { id: "c", midi: 60, pitchName: "C4", startTime: 0, endTime: 0.44, noteSeconds: 0.44, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: false },
  { id: "d", midi: 62, pitchName: "D4", startTime: 0.47, endTime: 0.79, noteSeconds: 0.32, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: true },
  { id: "e", midi: 64, pitchName: "E4", startTime: 1.31, endTime: 1.94, noteSeconds: 0.63, phraseId: "phrase-2", hasBreathBefore: true, hasBreathAfter: false }
];
const source = buildRhythmData(original, { selectedBpm: 96, quantizationMode: "original", rhythmSource: "original", quantizationEnabled: false });
assert.equal(source.rhythmSource, "original");
assert.equal(source.quantizationEnabled, false);
assert.equal(source.quantizedNotes.length, 0);
assert.deepEqual(source.originalRhythmNotes.map((note) => [note.startTime, note.endTime]), original.map((note) => [note.startTime, note.endTime]));

const preview = quantizeRhythmNotes(source.originalRhythmNotes, { selectedBpm: 96, selectedTimeSignature: "4/4", quantizationMode: "light", quantizationGrid: "eighth", bpmSource: "detected", bpmConfidence: 0.9 });
assert.deepEqual(preview.quantizedNotes.map((note) => note.midi), original.map((note) => note.midi), "preview cannot alter pitch order");
assert.deepEqual(preview.quantizedNotes.map((note) => note.phraseId), original.map((note) => note.phraseId), "preview cannot cross phrase boundaries");
assert.equal(preview.quantizedNotes.filter((note) => note.hasBreathBefore).length, 1, "preview must keep a breath boundary");
assert.ok(preview.analysis.maxMovementMs <= preview.analysis.maxAllowedMovementMs + 0.001 || preview.analysis.blocked, "unsafe movement must be marked blocked");

const editedOriginal = annotateOriginalRhythmNotes(original, source);
const plan = createPhrasePlaybackPlan(editedOriginal.notes, { instrument: "Violin" });
assert.deepEqual(plan.map((entry) => entry.startOffset), [0, 0.47, 1.31], "player must schedule recorded source onsets");
assert.ok(plan[0].duration + plan[0].crossfadeSeconds > plan[1].startOffset, "legato may extend only the preceding tail");
assert.ok(plan[2].startOffset - (plan[1].startOffset + plan[1].duration) > 0.45, "recorded breath gap must remain");

console.log(JSON.stringify({
  status: "passed",
  formalSource: source.rhythmSource,
  originalTimes: source.originalRhythmNotes.map((note) => ({ startTime: note.startTime, duration: note.noteSeconds })),
  preview: { blocked: preview.analysis.blocked, maxMovementMs: preview.analysis.maxMovementMs, totalDurationChangeRatio: preview.analysis.totalDurationChangeRatio },
  playbackStarts: plan.map((entry) => entry.startOffset)
}, null, 2));
