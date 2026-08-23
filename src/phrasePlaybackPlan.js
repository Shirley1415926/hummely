import { VOICE_RECOGNITION_CONFIG } from "./voiceRecognitionConfig.js";

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function noteDuration(note, beatUnitSeconds) {
  return Math.max(0.04, finite(note.noteSeconds, finite(note.beats, 1) * beatUnitSeconds));
}

function rawGap(previous, next) {
  if (!Number.isFinite(previous?.endTime) || !Number.isFinite(next?.startTime)) return 0;
  return Math.max(0, next.startTime - previous.endTime);
}

export const INSTRUMENT_LEGATO = Object.freeze({
  Piano: Object.freeze({ crossfadeSeconds: 0.024, internalAttackSeconds: 0.006, phraseAttackSeconds: 0.01, releaseSeconds: 0.28 }),
  Guitar: Object.freeze({ crossfadeSeconds: 0.022, internalAttackSeconds: 0.005, phraseAttackSeconds: 0.006, releaseSeconds: 0.24 }),
  Violin: Object.freeze({ crossfadeSeconds: 0.052, internalAttackSeconds: 0.014, phraseAttackSeconds: 0.065, releaseSeconds: 0.23 }),
  Flute: Object.freeze({ crossfadeSeconds: 0.046, internalAttackSeconds: 0.012, phraseAttackSeconds: 0.042, releaseSeconds: 0.2 }),
  Mallet: Object.freeze({ crossfadeSeconds: 0.012, internalAttackSeconds: 0.003, phraseAttackSeconds: 0.004, releaseSeconds: 0.14 })
});

export function phraseLegatoSettings(instrument) {
  return INSTRUMENT_LEGATO[instrument] || INSTRUMENT_LEGATO.Piano;
}

/**
 * Converts phrase-tagged notation into one audio scheduling plan. Same-phrase
 * notes overlap briefly; a breath keeps the recorded silence and starts anew.
 */
export function createPhrasePlaybackPlan(notes, {
  startAt = 0,
  beatUnitSeconds = 0.55,
  instrument = "Piano",
  articulation = "legato",
  config = VOICE_RECOGNITION_CONFIG
} = {}) {
  const settings = phraseLegatoSettings(instrument);
  const selected = notes.slice(startAt);
  if (!selected.length) return [];

  const firstSourceStart = finite(selected[0].startTime, 0);
  const isSingleNotePlan = selected.length === 1;
  const plan = [];
  let fallbackCursor = 0;
  selected.forEach((note, offset) => {
    const index = startAt + offset;
    const previous = selected[offset - 1];
    // A damaged or very short stored duration must not make a valid one-note
    // melody inaudible. This affects playback only, never score timing.
    const duration = isSingleNotePlan
      ? Math.max(0.18, noteDuration(note, beatUnitSeconds))
      : noteDuration(note, beatUnitSeconds);
    const startsPhrase = !previous || note.phraseId !== previous.phraseId || Boolean(note.hasBreathBefore);
    const endsPhrase = !selected[offset + 1] || selected[offset + 1].phraseId !== note.phraseId || Boolean(note.hasBreathAfter);
    const next = selected[offset + 1];
    const potentialCrossfade = articulation === "legato" && !endsPhrase && next
      ? Math.min(settings.crossfadeSeconds, duration * 0.34, noteDuration(next, beatUnitSeconds) * 0.34)
      : 0;
    const sourceStart = finite(note.startTime, NaN);
    const startOffset = Number.isFinite(sourceStart) ? Math.max(0, sourceStart - firstSourceStart) : fallbackCursor;

    // Crossfading extends the preceding release only. It never advances this note's source onset.
    plan.push({
      index,
      note,
      startOffset,
      duration,
      phraseId: note.phraseId || "phrase-1",
      startsPhrase,
      endsPhrase,
      crossfadeSeconds: potentialCrossfade,
      settings
    });
    fallbackCursor = startOffset + duration;
  });

  return plan;
}
