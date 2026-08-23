import assert from "node:assert/strict";
import { createPhrasePlaybackPlan } from "../src/phrasePlaybackPlan.js";

const notes = [
  { midi: 60, noteSeconds: 0.4, startTime: 0, endTime: 0.4, phraseId: "phrase-1" },
  { midi: 62, noteSeconds: 0.4, startTime: 0.4, endTime: 0.8, phraseId: "phrase-1" },
  { midi: 64, noteSeconds: 0.4, startTime: 1.3, endTime: 1.7, phraseId: "phrase-2", hasBreathBefore: true }
];

for (const instrument of ["Piano", "Mallet", "Guitar", "Violin", "Flute"]) {
  const plan = createPhrasePlaybackPlan(notes, { instrument });
  const sourceOnsetsAreKept = plan[0].startOffset === 0 && plan[1].startOffset === 0.4 && plan[2].startOffset === 1.3;
  const legatoOnlyExtendsThePreviousTail = plan[0].startOffset + plan[0].duration + plan[0].crossfadeSeconds > plan[1].startOffset;
  const breathIsKept = plan[2].startOffset >= plan[1].startOffset + plan[1].duration + 0.45;
  assert.ok(sourceOnsetsAreKept && legatoOnlyExtendsThePreviousTail && breathIsKept, instrument + " preserves source timing and breaths");
}

for (const instrument of ["Piano", "Mallet", "Violin"]) {
  const plan = createPhrasePlaybackPlan([
    { midi: 60, startTime: 0, endTime: 0, noteSeconds: 0, phraseId: "phrase-1" }
  ], { instrument });
  assert.equal(plan.length, 1, instrument + " creates a one-note plan");
  assert.equal(plan[0].startOffset, 0, instrument + " preserves startTime=0");
  assert.equal(plan[0].startsPhrase, true, instrument + " marks a single phrase start");
  assert.equal(plan[0].endsPhrase, true, instrument + " marks a single phrase end");
  assert.ok(plan[0].duration >= 0.18, instrument + " guarantees an audible one-note duration");
}

console.log(JSON.stringify({
  status: "passed",
  multiNoteOnsets: createPhrasePlaybackPlan(notes, { instrument: "Piano" }).map((entry) => entry.startOffset),
  singleNoteDuration: createPhrasePlaybackPlan([{ midi: 60, startTime: 0, endTime: 0, noteSeconds: 0, phraseId: "phrase-1" }], { instrument: "Piano" })[0].duration
}, null, 2));
