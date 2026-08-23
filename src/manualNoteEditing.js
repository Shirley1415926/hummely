function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function durationOf(note, beatUnitSeconds) {
  const start = finite(note.startTime, 0);
  const end = finite(note.endTime, start);
  return Math.max(0.05, finite(note.noteSeconds, end > start ? end - start : finite(note.beats, 1) * beatUnitSeconds));
}

function manualEdit(type, sourceIds, timestamp) {
  return { type, sourceIds, timestamp, preservesOriginalTiming: true };
}

/** Pure note transforms used by the sheet and persistence regression tests. */
export function splitManualNote(notes, index, { beatUnitSeconds = 0.55, createNote, timestamp = new Date().toISOString() } = {}) {
  const source = notes[index];
  if (!source || typeof createNote !== "function") return notes;
  const duration = durationOf(source, beatUnitSeconds);
  if (duration < 0.16) return notes;
  const firstSeconds = duration / 2;
  const secondSeconds = duration - firstSeconds;
  const startTime = finite(source.startTime, 0);
  const sourceIds = [source.id || "note-" + index];
  const firstEdit = manualEdit("split", sourceIds, timestamp);
  const first = {
    ...source,
    ...createNote(source.midi, Math.max(0.25, finite(source.beats, duration / beatUnitSeconds) / 2), beatUnitSeconds, firstSeconds, {
      frequency: source.frequency,
      startTime,
      endTime: startTime + firstSeconds
    }),
    manualEdit: firstEdit,
    hasBreathAfter: false
  };
  const second = {
    ...source,
    id: (source.id || "note-" + index) + "-manual-split-" + timestamp,
    ...createNote(source.midi, Math.max(0.25, finite(source.beats, duration / beatUnitSeconds) - finite(first.beats, 0)), beatUnitSeconds, secondSeconds, {
      frequency: source.frequency,
      startTime: startTime + firstSeconds,
      endTime: startTime + duration
    }),
    manualEdit: manualEdit("split", sourceIds, timestamp),
    hasBreathBefore: false,
    hasBreathAfter: source.hasBreathAfter
  };
  return [...notes.slice(0, index), first, second, ...notes.slice(index + 1)];
}

export function mergeManualNotes(notes, index, neighbourIndex, { beatUnitSeconds = 0.55, createNote, timestamp = new Date().toISOString() } = {}) {
  const firstIndex = Math.min(index, neighbourIndex);
  const secondIndex = Math.max(index, neighbourIndex);
  const first = notes[firstIndex];
  const second = notes[secondIndex];
  if (!first || !second || first.midi !== second.midi || typeof createNote !== "function") return notes;
  const startTime = finite(first.startTime, 0);
  const endTime = Math.max(finite(second.endTime, startTime + durationOf(second, beatUnitSeconds)), startTime + 0.05);
  const duration = endTime - startTime;
  const beats = Math.max(0.25, duration / beatUnitSeconds);
  const merged = {
    ...first,
    ...createNote(first.midi, beats, beatUnitSeconds, duration, {
      frequency: first.frequency,
      startTime,
      endTime
    }),
    originalMidi: first.originalMidi ?? first.midi,
    autoTune: Boolean(first.autoTune && second.autoTune),
    phraseId: first.phraseId,
    phraseStart: first.phraseStart,
    phraseEnd: second.phraseEnd ?? endTime,
    hasBreathBefore: first.hasBreathBefore,
    hasBreathAfter: second.hasBreathAfter,
    manualEdit: manualEdit("merge", [first.id || "note-" + firstIndex, second.id || "note-" + secondIndex], timestamp)
  };
  return [...notes.slice(0, firstIndex), merged, ...notes.slice(secondIndex + 1)];
}
