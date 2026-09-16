import assert from "node:assert/strict";
import { analyzeMelodyForAgent, applyMelodyAgentPlan, createMelodyAgentPlan } from "../src/melodyAgent.js";

const melody = {
  tempo: 108,
  beatUnitSeconds: 0.55,
  notes: [
    { midi: 64, noteSeconds: 0.55, durationSeconds: 0.55, beats: 1, startTime: 0, endTime: 0.55, phraseId: "p1" },
    { midi: 67, noteSeconds: 0.55, durationSeconds: 0.55, beats: 1, startTime: 0.55, endTime: 1.1, phraseId: "p1" },
    { midi: 69, noteSeconds: 0.3, durationSeconds: 0.3, beats: 0.5, startTime: 1.1, endTime: 1.4, phraseId: "p1" }
  ]
};

const analysis = analyzeMelodyForAgent(melody);
assert.equal(analysis.ready, true);
assert.equal(analysis.noteCount, 3);
assert.equal(analysis.pitchRange, 5);

const plan = createMelodyAgentPlan("更舒缓一点，延长尾音，还有点太高", { melody });
assert.equal(plan.status, "awaiting_approval");
assert.ok(plan.steps.some((step) => step.tool === "transpose_melody"));
assert.ok(plan.steps.some((step) => step.tool === "prepare_rhythm_preview"));
assert.ok(plan.steps.some((step) => step.tool === "extend_final_note"));

const result = applyMelodyAgentPlan(plan, melody);
assert.equal(result.melody.notes[0].midi, 62);
assert.ok(result.melody.notes[2].noteSeconds > melody.notes[2].noteSeconds);
assert.equal(melody.notes[0].midi, 64, "agent execution must not mutate the source melody");

const blocked = createMelodyAgentPlan("帮我优化", { melody: { notes: [] } });
assert.equal(blocked.status, "blocked");

const clarification = createMelodyAgentPlan("给它一种宇宙的感觉", { melody });
assert.equal(clarification.status, "needs_clarification");

console.log("Melody agent checks passed");
