import assert from "node:assert/strict";
import { splitManualNote, mergeManualNotes } from "../src/manualNoteEditing.js";
import { normalizeProject } from "../src/projectStorage.js";

function createNote(midi, beats, beatUnitSeconds, noteSeconds, details) {
  return {
    midi,
    pitchName: midi === 60 ? "C4" : "D4",
    frequency: details.frequency || 261.63,
    beats,
    noteSeconds,
    durationSeconds: noteSeconds,
    startTime: details.startTime,
    endTime: details.endTime
  };
}

const source = [{ id: "c4", midi: 60, pitchName: "C4", frequency: 261.63, beats: 2, noteSeconds: 1, durationSeconds: 1, startTime: 0, endTime: 1, phraseId: "phrase-1", hasBreathBefore: false, hasBreathAfter: false }];
const split = splitManualNote(source, 0, { beatUnitSeconds: 0.5, createNote, timestamp: "2026-08-23T00:00:00.000Z" });
assert.equal(split.length, 2, "manual split creates two notes");
assert.deepEqual(split.map((note) => [note.midi, note.startTime, note.endTime, note.manualEdit.type]), [[60, 0, 0.5, "split"], [60, 0.5, 1, "split"]]);

const saved = normalizeProject({
  id: "manual-edit-test",
  name: "手动编辑测试",
  audioBlob: new Blob(["audio"]),
  editedNotes: split,
  processedDetectedNotes: source,
  transcriptions: { original: { editedNotes: split, processedDetectedNotes: source, audioAnalysis: { candidates: [] } } }
});
const reopened = normalizeProject(saved);
assert.equal(reopened.editedNotes.length, 2, "split notes survive save and reopen normalization");
assert.equal(reopened.editedNotes[1].manualEdit.type, "split");

const merged = mergeManualNotes(reopened.editedNotes, 0, 1, { beatUnitSeconds: 0.5, createNote, timestamp: "2026-08-23T00:00:01.000Z" });
assert.equal(merged.length, 1, "manual merge returns to one note");
assert.deepEqual([merged[0].startTime, merged[0].endTime, merged[0].noteSeconds, merged[0].manualEdit.type], [0, 1, 1, "merge"]);
const reopenedMerged = normalizeProject({ ...saved, editedNotes: merged, transcriptions: { original: { ...saved.transcriptions.original, editedNotes: merged } } });
assert.equal(reopenedMerged.editedNotes[0].manualEdit.type, "merge", "merged result survives persistence normalization");
console.log(JSON.stringify({ status: "passed", splitNotes: reopened.editedNotes.length, mergedNotes: reopenedMerged.editedNotes.length, manualEdit: reopenedMerged.editedNotes[0].manualEdit }, null, 2));
