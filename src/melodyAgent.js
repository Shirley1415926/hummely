const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const PITCH_META = [
  ["1", "Do"], ["#1", "Di"], ["2", "Re"], ["#2", "Ri"],
  ["3", "Mi"], ["4", "Fa"], ["#4", "Fi"], ["5", "So"],
  ["#5", "Si"], ["6", "La"], ["#6", "Li"], ["7", "Ti"]
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pitchName(midi) {
  const safeMidi = Math.round(midi);
  return `${NOTE_NAMES[((safeMidi % 12) + 12) % 12]}${Math.floor(safeMidi / 12) - 1}`;
}

function durationLabel(beats) {
  if (beats >= 4) return beats > 4 ? "延长全音" : "全音";
  if (beats >= 3) return "附点二分";
  if (beats >= 2) return "二分";
  if (beats >= 1.5) return "附点四分";
  if (beats >= 1) return "四分";
  return "八分";
}

function syncPitch(note, midi) {
  const nextMidi = clamp(Math.round(midi), 36, 96);
  const pitchClass = ((nextMidi % 12) + 12) % 12;
  return {
    ...note,
    midi: nextMidi,
    originalMidi: nextMidi,
    pitchName: pitchName(nextMidi),
    octave: Math.floor(nextMidi / 12) - 1,
    frequency: 440 * 2 ** ((nextMidi - 69) / 12),
    pitchIndex: clamp(nextMidi - 55, 0, 26),
    jianpu: PITCH_META[pitchClass][0],
    solfege: PITCH_META[pitchClass][1],
    autoTune: false,
    agentEdit: "transpose"
  };
}

export function analyzeMelodyForAgent(melody = {}) {
  const notes = Array.isArray(melody.notes) ? melody.notes : [];
  if (!notes.length) {
    return {
      ready: false,
      noteCount: 0,
      observations: ["还没有可分析的旋律，需要先完成录音与识别。"]
    };
  }

  const midis = notes.map((note) => Number(note.midi)).filter(Number.isFinite);
  const durations = notes.map((note) => Math.max(0.04, Number(note.noteSeconds ?? note.durationSeconds) || 0.04));
  const minimumMidi = Math.min(...midis);
  const maximumMidi = Math.max(...midis);
  const pitchRange = maximumMidi - minimumMidi;
  const phraseCount = new Set(notes.map((note) => note.phraseId).filter(Boolean)).size || 1;
  const typicalDuration = median(durations);
  const endingDuration = durations[durations.length - 1];
  const tempo = Math.round(Number(melody.tempo) || (60 / (Number(melody.beatUnitSeconds) || 0.55)));
  const repeatedMotions = notes.slice(1).filter((note, index) => note.midi === notes[index].midi).length;
  const observations = [
    `识别到 ${notes.length} 个音符、${phraseCount} 个乐句，音域 ${pitchName(minimumMidi)}–${pitchName(maximumMidi)}。`,
    `当前约 ${tempo} BPM，常见音符时值 ${typicalDuration.toFixed(2)} 秒。`
  ];
  if (pitchRange >= 12) observations.push(`音域跨度 ${pitchRange} 个半音，试唱时需要关注最高音是否舒适。`);
  if (endingDuration < typicalDuration * 0.9) observations.push("尾音短于主要时值，可以用延长来增强收束感。");
  if (repeatedMotions >= Math.max(2, notes.length / 3)) observations.push("同音连续较多，气口和起音会比移调更影响听感。");

  return {
    ready: true,
    noteCount: notes.length,
    phraseCount,
    minimumMidi,
    maximumMidi,
    pitchRange,
    tempo,
    typicalDuration,
    endingDuration,
    observations
  };
}

function makeStep(tool, label, description, args = {}, effect = "reversible") {
  return { id: `${tool}-${Math.random().toString(16).slice(2)}`, tool, label, description, args, effect };
}

export function createMelodyAgentPlan(goal, context = {}) {
  const normalizedGoal = String(goal || "").trim();
  const analysis = analyzeMelodyForAgent(context.melody || { notes: context.notes, tempo: context.tempo });
  const plan = {
    id: `agent-plan-${Date.now()}`,
    goal: normalizedGoal,
    status: analysis.ready ? "awaiting_approval" : "blocked",
    confidence: 0,
    analysis,
    steps: [],
    createdAt: new Date().toISOString()
  };

  if (!analysis.ready) {
    plan.summary = "需要先有一段可编辑的旋律。";
    plan.nextAction = "请先录音或导入音频，完成旋律识别后再让 Agent 调整。";
    return plan;
  }

  const add = (step) => {
    if (!plan.steps.some((candidate) => candidate.tool === step.tool)) plan.steps.push(step);
  };
  const lower = /(低一点|降调|男声|太高|lower)/iu.test(normalizedGoal);
  const higher = /(高一点|升调|女声|更明亮|higher)/iu.test(normalizedGoal);
  const calm = /(舒缓|慢一点|慢些|抒情|柔和|ballad|calm)/iu.test(normalizedGoal);
  const lively = /(轻快|活泼|快一点|律动|upbeat|faster)/iu.test(normalizedGoal);
  const regularRhythm = /(节奏.{0,4}(整|稳|准)|规整|卡拍|量化)/u.test(normalizedGoal);
  const longerEnding = /((结尾|尾音).{0,5}(延长|更长|拉长|收束)|(延长|拉长).{0,3}(结尾|尾音))/u.test(normalizedGoal);
  const genericImprove = /(帮我优化|自动优化|给个建议|更好听|整理一下)/u.test(normalizedGoal);

  if (lower && !higher) add(makeStep("transpose_melody", "整体降低 2 个半音", "保留旋律关系，把整体音区移到更舒适的位置。", { semitones: -2 }));
  if (higher && !lower) add(makeStep("transpose_melody", "整体升高 2 个半音", "保留旋律轮廓，让音色听起来更明亮。", { semitones: 2 }));

  if (calm) {
    const targetBpm = clamp(Math.round(analysis.tempo * 0.86), 52, 96);
    add(makeStep("prepare_rhythm_preview", `生成 ${targetBpm} BPM 舒缓节奏预览`, "只生成可对比的节奏方案，不直接覆盖原节奏。", { selectedBpm: targetBpm, quantizationMode: "balanced", quantizationGrid: "eighth" }, "preview"));
    add(makeStep("set_instrument", "切换为钢琴音色", "用软起音更清楚地检查抒情旋律。", { instrument: "Piano" }));
    add(makeStep("set_playback_style", "使用连奏", "尽量保留人声乐句的连续感。", { style: "legato" }));
  }

  if (lively) {
    const targetBpm = clamp(Math.round(analysis.tempo * 1.14), 84, 150);
    add(makeStep("prepare_rhythm_preview", `生成 ${targetBpm} BPM 轻快节奏预览`, "先对比节奏改变，确认后再替换正式曲谱。", { selectedBpm: targetBpm, quantizationMode: "balanced", quantizationGrid: "eighth" }, "preview"));
    add(makeStep("set_instrument", "切换为木琴音色", "颗粒感更容易暴露节奏边界。", { instrument: "Mallet" }));
    add(makeStep("set_playback_style", "使用断奏", "强化每个音的起音和律动。", { style: "detached" }));
  }

  if (regularRhythm && !plan.steps.some((step) => step.tool === "prepare_rhythm_preview")) {
    add(makeStep("prepare_rhythm_preview", "生成平衡量化预览", "采用八分音符网格，保留气口并限制时值移动。", { selectedBpm: analysis.tempo, quantizationMode: "balanced", quantizationGrid: "eighth" }, "preview"));
  }

  if (longerEnding) add(makeStep("extend_final_note", "延长尾音", "将最后一个音延长约一拍，增加乐句收束感。", { beats: 1 }));
  if (/钢琴/u.test(normalizedGoal)) add(makeStep("set_instrument", "切换为钢琴音色", "使用钢琴检查旋律走向。", { instrument: "Piano" }));
  if (/(木琴|马林巴)/u.test(normalizedGoal)) add(makeStep("set_instrument", "切换为木琴音色", "使用更清晰的颗粒感检查节奏。", { instrument: "Mallet" }));
  if (/连奏/u.test(normalizedGoal)) add(makeStep("set_playback_style", "使用连奏", "保留乐句之间的自然衔接。", { style: "legato" }));
  if (/(断奏|颗粒)/u.test(normalizedGoal)) add(makeStep("set_playback_style", "使用断奏", "让音符边界更容易被听见。", { style: "detached" }));

  if (genericImprove) {
    if (analysis.endingDuration < analysis.typicalDuration * 0.9) {
      add(makeStep("extend_final_note", "延长尾音", "尾音相对较短，先增加一拍收束感。", { beats: 1 }));
    }
    add(makeStep("prepare_rhythm_preview", "生成平衡量化预览", "保留原节奏作为正式版本，先用可撤销预览检查节奏。", { selectedBpm: analysis.tempo, quantizationMode: "balanced", quantizationGrid: "eighth" }, "preview"));
    add(makeStep("set_instrument", "使用钢琴进行校验", "钢琴音色便于听清音高与节奏问题。", { instrument: "Piano" }));
  }

  if (!plan.steps.length) {
    plan.status = "needs_clarification";
    plan.summary = "我已读取旋律，但还无法把这个目标安全映射为可执行工具。";
    plan.nextAction = "可以试试：“更舒缓一点并延长尾音”、“降低两个半音”或“把节奏整理得更规整”。";
    return plan;
  }

  plan.confidence = Number(clamp(0.72 + plan.steps.length * 0.045, 0.72, 0.93).toFixed(2));
  plan.summary = `已将目标拆成 ${plan.steps.length} 个可撤销步骤，等待你确认后执行。`;
  plan.nextAction = "检查计划后点击“确认执行”；节奏类动作只会生成预览。";
  return plan;
}

export function applyMelodyAgentPlan(plan, melody = {}) {
  const before = analyzeMelodyForAgent(melody);
  const next = { ...melody, notes: (melody.notes || []).map((note) => ({ ...note })) };
  const appliedTools = [];
  const beatUnitSeconds = Number(next.beatUnitSeconds) || 0.55;

  for (const step of plan?.steps || []) {
    if (step.tool === "transpose_melody") {
      next.notes = next.notes.map((note) => syncPitch(note, note.midi + Number(step.args.semitones || 0)));
      appliedTools.push(step.tool);
    }
    if (step.tool === "extend_final_note" && next.notes.length) {
      const finalNote = next.notes[next.notes.length - 1];
      const addedBeats = Math.max(0.25, Number(step.args.beats) || 1);
      const addedSeconds = addedBeats * beatUnitSeconds;
      finalNote.beats = Math.max(0.25, Number(finalNote.beats) || 1) + addedBeats;
      finalNote.noteSeconds = Math.max(0.04, Number(finalNote.noteSeconds ?? finalNote.durationSeconds) || beatUnitSeconds) + addedSeconds;
      finalNote.durationSeconds = finalNote.noteSeconds;
      finalNote.duration = durationLabel(finalNote.beats);
      if (Number.isFinite(finalNote.endTime)) finalNote.endTime += addedSeconds;
      finalNote.phraseEnd = Number.isFinite(finalNote.endTime) ? finalNote.endTime : finalNote.phraseEnd;
      finalNote.agentEdit = "extend-final-note";
      appliedTools.push(step.tool);
    }
  }

  const after = analyzeMelodyForAgent(next);
  return {
    melody: next,
    appliedTools,
    before,
    after,
    review: [
      appliedTools.includes("transpose_melody")
        ? `音域已从 ${pitchName(before.minimumMidi)}–${pitchName(before.maximumMidi)} 调整为 ${pitchName(after.minimumMidi)}–${pitchName(after.maximumMidi)}。`
        : "旋律的核心音高轮廓保持不变。",
      appliedTools.includes("extend_final_note")
        ? `尾音已延长至 ${after.endingDuration.toFixed(2)} 秒。`
        : "原始音符时值保持不变。"
    ]
  };
}

export const MELODY_AGENT_EXAMPLES = [
  "让这段旋律更舒缓，用钢琴连奏，并延长尾音",
  "调整得更轻快，节奏规整一点",
  "这段太高了，整体降低两个半音"
];
