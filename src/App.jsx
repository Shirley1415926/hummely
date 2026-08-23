import { useEffect, useRef, useState } from "react";
import { detectMonophonicNotesWithBasicPitch } from "./basicPitchTranscriber";
import VexFlowScore from "./VexFlowScore";
import { DEFAULT_TONIC, getJianpuNote, parseTimeSignature } from "./notationUtils";
import { createRealtimePitchTracker } from "./realtimePitch";
import {
  HUMMING_INTERPRETER_MODES,
  HUMMING_INTERPRETER_VERSION,
  RECOGNITION_ENGINE_VERSION
} from "./voiceRecognitionConfig";
import { getProject, listProjects, removeProject, saveProject, PROJECT_SCHEMA_VERSION } from "./projectStorage";
import { createTunedVocalPreview, VOCAL_TUNING_VERSION } from "./vocalAutoTune";
import { createPhrasePlaybackPlan } from "./phrasePlaybackPlan";
import { createSampledInstrumentEngine, isSampledInstrument } from "./sampledInstrumentEngine";
import { mergeManualNotes, splitManualNote } from "./manualNoteEditing";
import { MetronomeScheduler } from "./metronomeScheduler";
import {
  DEFAULT_METRONOME_SETTINGS,
  DEFAULT_RHYTHM_SETTINGS,
  getTimeSignature,
  METRONOME_SPEEDS,
  QUANTIZATION_GRIDS,
  QUANTIZATION_MODES
} from "./rhythmConfig";
import { annotateOriginalRhythmNotes, buildRhythmData, createRhythmExport, quantizeRhythmNotes } from "./rhythmEngine";

const durationOptions = [
  { label: "八分", beats: 0.5 },
  { label: "四分", beats: 1 },
  { label: "二分", beats: 2 },
  { label: "全音", beats: 4 }
];

// Singing is continuous: this profile decides how much expression becomes notation.
const transcriptionProfiles = {
  melody: {
    label: "旋律优先",
    shortDescription: "转音变自然",
    description: "过滤转音与颤音，乐器试听最自然",
    minStableFrames: 6,
    minStableSeconds: 0.075,
    maxPitchDrift: 0.35,
    minNoteSeconds: 0.09,
    glitchSeconds: 0.09,
    quantization: "soft"
  },
  ornament: {
    label: "保留装饰音",
    shortDescription: "保留短转音",
    description: "保留较短的经过音与装饰音",
    minStableFrames: 3,
    minStableSeconds: 0.035,
    maxPitchDrift: 0.65,
    minNoteSeconds: 0.045,
    glitchSeconds: 0.045,
    quantization: "soft"
  },
  free: {
    label: "自由节奏",
    shortDescription: "不强行卡拍",
    description: "过滤转音，但尽量保留你原来的时值",
    minStableFrames: 5,
    minStableSeconds: 0.06,
    maxPitchDrift: 0.45,
    minNoteSeconds: 0.07,
    glitchSeconds: 0.07,
    quantization: "free"
  },
  fast: {
    label: "快速旋律",
    shortDescription: "内部短音复核",
    description: "为快速哼唱保留更短的稳定音高",
    minStableFrames: 2,
    minStableSeconds: 0.022,
    maxPitchDrift: 0.8,
    minNoteSeconds: 0.03,
    glitchSeconds: 0.03,
    quantization: "soft",
    internal: true
  }
};

const arrangementAdvice = {
  "piano-ballad":
    "当前建议：先录一段尽量单线条、没有太多滑音的旋律，钢琴版最适合先检查音准和节奏。",
  "folk-pop":
    "当前建议：如果你的旋律更偏口语化，可以切到木吉他试听，主副歌的强弱会更容易听出来。",
  cinematic:
    "当前建议：如果结尾有长音，试着保留更长的时值，再用小提琴或长笛试听，会更有空间感。"
};

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const RECOGNITION_VERSION = RECOGNITION_ENGINE_VERSION;
const LAST_PROJECT_KEY = "hummely-last-project-id";

const jianpuMap = {
  0: { jianpu: "1", solfege: "Do" },
  1: { jianpu: "#1", solfege: "Di" },
  2: { jianpu: "2", solfege: "Re" },
  3: { jianpu: "#2", solfege: "Ri" },
  4: { jianpu: "3", solfege: "Mi" },
  5: { jianpu: "4", solfege: "Fa" },
  6: { jianpu: "#4", solfege: "Fi" },
  7: { jianpu: "5", solfege: "So" },
  8: { jianpu: "#5", solfege: "Si" },
  9: { jianpu: "6", solfege: "La" },
  10: { jianpu: "#6", solfege: "Li" },
  11: { jianpu: "7", solfege: "Ti" }
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToPitchName(midi) {
  const safeMidi = Math.round(midi);
  const octave = Math.floor(safeMidi / 12) - 1;
  return `${noteNames[((safeMidi % 12) + 12) % 12]}${octave}`;
}

function getPitchMeta(midi) {
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  return jianpuMap[pitchClass] || jianpuMap[0];
}

function durationLabelFromBeats(beats) {
  const option = durationOptions.find((item) => item.beats === beats);
  if (option) return option.label;
  if (beats === 1.5) return "附点四分";
  if (beats === 3) return "附点二分";
  if (beats > 4) return "延长全音";
  return beats > 1 ? "延长四分" : "八分";
}

function createNote(midi, beats, beatUnitSeconds, rawSeconds = beats * beatUnitSeconds, timing = {}) {
  const roundedMidi = Math.round(midi);
  const pitchMeta = getPitchMeta(roundedMidi);
  return {
    midi: roundedMidi,
    pitchName: midiToPitchName(roundedMidi),
    octave: Math.floor(roundedMidi / 12) - 1,
    ...(Number.isFinite(timing.frequency) ? { frequency: timing.frequency } : {}),
    ...(Number.isFinite(timing.startTime) ? { startTime: timing.startTime } : {}),
    ...(Number.isFinite(timing.endTime) ? { endTime: timing.endTime } : {}),
    beats,
    duration: durationLabelFromBeats(beats),
    durationSeconds: rawSeconds,
    noteSeconds: rawSeconds,
    pitchIndex: clamp(Math.round(midi) - 55, 0, 26),
    jianpu: pitchMeta.jianpu,
    solfege: pitchMeta.solfege
  };
}

function createProjectId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `melody-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nextUntitledProjectName(projects) {
  const highestNumber = projects.reduce((highest, project) => {
    const match = /^未命名旋律\s*(\d+)$/u.exec(project.name || "");
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `未命名旋律 ${highestNumber + 1}`;
}

function normalizeProjectName(value, fallback) {
  const trimmed = String(value || "").trim().replace(/\s+/gu, " ");
  return (trimmed || fallback).slice(0, 40);
}

function projectStatusLabel(status) {
  if (status === "edited") return "已修正";
  if (status === "recognized") return "已识别";
  return "待识别";
}

function projectSourceLabel(sourceType) {
  return sourceType === "import" ? "导入音频" : "现场哼唱";
}

function formatProjectDate(value) {
  if (!value) return "刚刚保存";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

const demoMelodies = [
  {
    title: "今晚想到的副歌",
    analysis: "示例旋律 · 识别置信度 89% · 第 3 个音符存在轻微跑音，建议校正",
    beatUnitSeconds: 0.56,
    confidence: 89,
    tempo: 107,
    notes: [
      createNote(64, 1, 0.56),
      createNote(66, 0.5, 0.56),
      createNote(64, 1, 0.56),
      createNote(60, 2, 0.56),
      createNote(62, 1, 0.56),
      createNote(64, 1, 0.56),
      createNote(67, 1, 0.56),
      createNote(64, 2, 0.56)
    ]
  },
  {
    title: "清晨冒出来的主旋律",
    analysis: "示例旋律 · 识别置信度 84% · 节奏整体稳定，结尾可尝试延长一拍形成记忆点",
    beatUnitSeconds: 0.52,
    confidence: 84,
    tempo: 115,
    notes: [
      createNote(62, 1, 0.52),
      createNote(64, 1, 0.52),
      createNote(67, 2, 0.52),
      createNote(66, 1, 0.52),
      createNote(64, 1, 0.52),
      createNote(62, 1, 0.52),
      createNote(60, 1, 0.52),
      createNote(59, 2, 0.52)
    ]
  }
];

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function estimatePitchYin(buffer, sampleRate) {
  let rms = 0;
  let mean = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    rms += buffer[index] * buffer[index];
    mean += buffer[index];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.004) {
    return { frequency: null, clarity: 0, rms };
  }

  const size = buffer.length;
  const minLag = Math.max(2, Math.floor(sampleRate / 1050));
  const maxLag = Math.min(Math.floor(size / 2), Math.floor(sampleRate / 75));
  if (maxLag <= minLag) {
    return { frequency: null, clarity: 0, rms };
  }

  mean /= size;
  const samples = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    // Centering removes the microphone's DC bias without altering the melody.
    samples[index] = buffer[index] - mean;
  }

  const difference = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index < size - lag; index += 1) {
      const delta = samples[index] - samples[index + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  const cmndf = new Float32Array(maxLag + 1);
  let runningSum = 0;
  let lagCount = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    runningSum += difference[lag];
    lagCount += 1;
    cmndf[lag] = runningSum ? (difference[lag] * lagCount) / runningSum : 1;
  }

  let bestLag = -1;
  const yinThreshold = 0.16;
  for (let lag = minLag + 1; lag < maxLag - 1; lag += 1) {
    if (cmndf[lag] < yinThreshold && cmndf[lag] <= cmndf[lag - 1]) {
      while (lag + 1 < maxLag && cmndf[lag + 1] < cmndf[lag]) {
        lag += 1;
      }
      bestLag = lag;
      break;
    }
  }

  if (bestLag === -1) {
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (bestLag === -1 || cmndf[lag] < cmndf[bestLag]) {
        bestLag = lag;
      }
    }
  }

  if (bestLag <= 0 || cmndf[bestLag] > 0.42) {
    return { frequency: null, clarity: 0, rms };
  }

  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const left = cmndf[bestLag - 1];
    const center = cmndf[bestLag];
    const right = cmndf[bestLag + 1];
    const denominator = left - 2 * center + right;
    if (Math.abs(denominator) > 0.000001) {
      refinedLag += 0.5 * (left - right) / denominator;
    }
  }

  const clarity = clamp(1 - cmndf[bestLag], 0, 1);
  const frequency = sampleRate / refinedLag;

  if (!Number.isFinite(frequency) || frequency < 75 || frequency > 1050 || clarity < 0.38) {
    return { frequency: null, clarity, rms };
  }

  return {
    frequency,
    clarity,
    rms
  };
}

function getTranscriptionProfile(mode) {
  return transcriptionProfiles[mode] || transcriptionProfiles.melody;
}

function quantizeSecondsToBeats(seconds, beatUnitSeconds, quantization = "soft") {
  if (quantization === "free") {
    const beats = Math.max(0.25, Math.round((seconds / beatUnitSeconds) * 4) / 4);
    return { beats, delta: Math.abs(seconds - beats * beatUnitSeconds) };
  }

  const candidates = [0.5, 0.75, 1, 1.5, 2, 3, 4].map((beats) => ({
    beats,
    delta: Math.abs(seconds - beats * beatUnitSeconds)
  }));
  candidates.sort((left, right) => left.delta - right.delta);
  return candidates[0];
}

function estimateBeatUnitSeconds(durations) {
  const candidates = durations
    .flatMap((duration) => [0.5, 0.75, 1, 1.5, 2, 3, 4].map((beats) => duration / beats))
    .filter((seconds) => seconds >= 0.24 && seconds <= 0.95);

  if (!candidates.length) {
    return 0.48;
  }

  return candidates.reduce((best, candidate) => {
    const score = durations.reduce((total, duration) => {
      const nearest = quantizeSecondsToBeats(duration, candidate).beats;
      // Prefer a pulse where most notes feel like ordinary beats, not dotted values.
      return total + Math.abs(duration / candidate - nearest) + Math.abs(nearest - 1) * 0.08;
    }, 0);
    return !best || score < best.score ? { seconds: candidate, score } : best;
  }, null).seconds;
}

function extractPlayableFrames(frames) {
  const thresholdProfiles = [
    { clarity: 0.64, rms: 0.009 },
    { clarity: 0.54, rms: 0.006 },
    { clarity: 0.44, rms: 0.004 }
  ];

  for (const profile of thresholdProfiles) {
    const candidates = frames
      .filter(
        (frame) =>
          frame.frequency &&
          Number.isFinite(frame.frequency) &&
          frame.frequency >= 80 &&
          frame.frequency <= 1200 &&
          frame.clarity > profile.clarity &&
          frame.rms > profile.rms
      )
      .map((frame) => ({
        ...frame,
        midiRaw: freqToMidi(frame.frequency)
      }));

    if (candidates.length >= 3) {
      return candidates;
    }
  }

  return [];
}

function createFallbackMelody(frames, title) {
  const playableFrames = frames
    .filter(
      (frame) =>
        frame.frequency &&
        Number.isFinite(frame.frequency) &&
        frame.frequency >= 80 &&
        frame.frequency <= 1200
    )
    .map((frame) => ({
      ...frame,
      midi: Math.round(freqToMidi(frame.frequency))
    }));

  if (!playableFrames.length) {
    return null;
  }

  const grouped = [];
  playableFrames.forEach((frame) => {
    const previous = grouped[grouped.length - 1];
    if (!previous) {
      grouped.push({
        midiValues: [frame.midi],
        frequencyValues: [frame.frequency],
        startTime: frame.time,
        endTime: frame.time,
        duration: 0.16
      });
      return;
    }

    if (Math.abs(median(previous.midiValues) - frame.midi) <= 2) {
      previous.midiValues.push(frame.midi);
      previous.frequencyValues.push(frame.frequency);
      previous.endTime = frame.time;
      previous.duration += 0.12;
    } else {
      grouped.push({
        midiValues: [frame.midi],
        frequencyValues: [frame.frequency],
        startTime: frame.time,
        endTime: frame.time,
        duration: 0.18
      });
    }
  });

  const beatUnitSeconds = clamp(median(grouped.map((item) => item.duration)) || 0.5, 0.35, 0.9);
  const notes = grouped.slice(0, 12).map((group) => {
    const midi = Math.round(median(group.midiValues));
    const quantized = quantizeSecondsToBeats(group.duration, beatUnitSeconds);
    return {
      ...createNote(midi, quantized.beats, beatUnitSeconds, group.duration, {
        frequency: median(group.frequencyValues),
        startTime: group.startTime,
        endTime: group.endTime
      }),
      phraseId: "phrase-1",
      phraseStart: grouped[0]?.startTime || group.startTime,
      phraseEnd: grouped[grouped.length - 1]?.endTime || group.endTime,
      hasBreathBefore: false,
      hasBreathAfter: false
    };
  });

  if (!notes.length) {
    return null;
  }

  return {
    title,
    analysis: `真实录音转译 · 宽松识别模式 · ${notes.length} 个音符 · 建议手动微调`,
    beatUnitSeconds,
    confidence: 58,
    tempo: Math.round(60 / beatUnitSeconds),
    notes
  };
}

async function extractFramesFromBlob(blob, audioContext) {
  if (!blob) {
    return [];
  }

  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const channelData = decoded.getChannelData(0);
  const frames = [];
  // Shorter offline windows preserve fast hummed notes without changing live monitoring.
  const windowSize = 1024;
  const hopSize = 256;

  for (let offset = 0; offset + windowSize < channelData.length; offset += hopSize) {
    const slice = channelData.slice(offset, offset + windowSize);
    const analysis = estimatePitchYin(slice, decoded.sampleRate);
    frames.push({
      time: offset / decoded.sampleRate,
      frequency: analysis.frequency,
      clarity: analysis.clarity,
      rms: analysis.rms
    });
  }

  return frames;
}

function estimateFrameHop(frames) {
  const intervals = frames
    .slice(1)
    .map((frame, index) => frame.time - frames[index].time)
    .filter((interval) => interval > 0 && interval < 0.08);
  return clamp(median(intervals) || 0.012, 0.006, 0.05);
}

function stabilizePitchTrack(frames, profile) {
  let stableMidi = Math.round(frames[0].midiRaw);
  let candidate = null;

  return frames.map((frame) => {
    const nearbyPitches = frames
      .filter((item) => Math.abs(item.time - frame.time) <= 0.028)
      .map((item) => item.midiRaw);
    const proposedMidi = Math.round(median(nearbyPitches));
    const recentPitches = frames
      .filter((item) => item.time <= frame.time && item.time >= frame.time - 0.075)
      .map((item) => item.midiRaw);
    const midpoint = Math.floor(recentPitches.length / 2);
    const recentDrift = midpoint
      ? Math.abs(median(recentPitches.slice(0, midpoint)) - median(recentPitches.slice(midpoint)))
      : 0;
    const hasSettled = recentDrift <= profile.maxPitchDrift;

    if (proposedMidi === stableMidi) {
      candidate = null;
    } else if (candidate && candidate.midi === proposedMidi) {
      candidate.count += 1;
      if (
        hasSettled &&
        (candidate.count >= profile.minStableFrames ||
          frame.time - candidate.startTime >= profile.minStableSeconds)
      ) {
        stableMidi = proposedMidi;
        candidate = null;
      }
    } else {
      candidate = { midi: proposedMidi, count: 1, startTime: frame.time };
    }

    return { ...frame, midi: stableMidi };
  });
}

function scoreMelodyCandidate(melody) {
  if (!melody) {
    return -Infinity;
  }
  return melody.notes.length * 16 + melody.confidence * 0.7;
}

function buildMelodyFromFrames(frames, title, mode = "melody") {
  if (!frames.length) {
    return null;
  }

  const profile = getTranscriptionProfile(mode);

  const filteredFrames = extractPlayableFrames(frames);
  if (filteredFrames.length < 3) {
    return createFallbackMelody(frames, title);
  }

  const frameHop = estimateFrameHop(filteredFrames);
  const pitchTrack = stabilizePitchTrack(filteredFrames, profile);
  const segments = [];
  let current = null;

  pitchTrack.forEach((frame) => {
    if (!current) {
      current = {
        midi: frame.midi,
        start: frame.time,
        end: frame.time,
        clarityValues: [frame.clarity],
        frequencyValues: [frame.frequency]
      };
      return;
    }

    const continuous = frame.time - current.end <= frameHop * 2.8;
    if (frame.midi === current.midi && continuous) {
      current.end = frame.time;
      current.clarityValues.push(frame.clarity);
      current.frequencyValues.push(frame.frequency);
      return;
    }

    segments.push(current);
    current = {
      midi: frame.midi,
      start: frame.time,
      end: frame.time,
      clarityValues: [frame.clarity],
      frequencyValues: [frame.frequency]
    };
  });

  if (current) {
    segments.push(current);
  }

  const normalizedSegments = segments.map((segment) => ({
    ...segment,
    duration: Math.max(frameHop, segment.end - segment.start + frameHop)
  }));

  // A passing tone without a new stable landing is an ornament, not a piano note.
  const cleanedSegments = [];
  normalizedSegments.forEach((segment, index) => {
    const previous = cleanedSegments[cleanedSegments.length - 1];
    const next = normalizedSegments[index + 1];
    const isBriefGlitch =
      segment.duration < profile.glitchSeconds && previous && next && previous.midi === next.midi;

    if (isBriefGlitch) {
      previous.end = next.end;
      previous.duration += segment.duration + next.duration;
      previous.clarityValues.push(...segment.clarityValues, ...next.clarityValues);
      previous.frequencyValues.push(...segment.frequencyValues, ...next.frequencyValues);
      normalizedSegments[index + 1] = { ...next, skip: true };
      return;
    }

    if (!segment.skip) {
      cleanedSegments.push(segment);
    }
  });

  const noteSegments = cleanedSegments.filter((segment) => segment.duration >= profile.minNoteSeconds);
  if (!noteSegments.length) {
    return createFallbackMelody(frames, title);
  }

  const noteDurations = noteSegments.map((segment) => segment.duration);
  const beatUnitSeconds = clamp(estimateBeatUnitSeconds(noteDurations), 0.24, 0.95);
  const notes = noteSegments.map((segment) => {
    const quantized = quantizeSecondsToBeats(segment.duration, beatUnitSeconds, profile.quantization);
    return {
      ...createNote(segment.midi, quantized.beats, beatUnitSeconds, segment.duration, {
        frequency: median(segment.frequencyValues),
        startTime: segment.start,
        endTime: segment.end
      }),
      phraseId: "phrase-1",
      phraseStart: noteSegments[0]?.start || segment.start,
      phraseEnd: noteSegments[noteSegments.length - 1]?.end || segment.end,
      hasBreathBefore: false,
      hasBreathAfter: false
    };
  });

  const meanClarity = median(filteredFrames.map((frame) => frame.clarity));
  const coverage = filteredFrames.length / frames.length;
  const confidence = Math.round(
    clamp(meanClarity * 54 + coverage * 28 + Math.min(18, notes.length * 2), 48, 97)
  );
  const tempo = Math.round(60 / beatUnitSeconds);

  return {
    title,
    analysis: `真实录音转译 · ${profile.label} · ${notes.length} 个音符 · 识别置信度 ${confidence}% · ${tempo} BPM`,
    beatUnitSeconds,
    confidence,
    tempo,
    notes
  };
}

function buildMelodyFromBasicPitchEvents(events, title) {
  if (!events.length) return null;

  const detectedNotes = events
    .map((event) => ({
      midi: Math.round(event.midi ?? event.pitchMidi),
      amplitude: Number(event.amplitude) || 0,
      startTime: Math.max(0, Number(event.startTime ?? event.startTimeSeconds) || 0),
      duration: Math.max(0, Number(event.duration ?? event.durationSeconds) || 0),
      phraseId: event.phraseId || "phrase-1",
      phraseStart: Number.isFinite(event.phraseStart) ? event.phraseStart : undefined,
      phraseEnd: Number.isFinite(event.phraseEnd) ? event.phraseEnd : undefined,
      hasBreathBefore: Boolean(event.hasBreathBefore),
      hasBreathAfter: Boolean(event.hasBreathAfter)
    }))
    .filter((event) => event.duration >= 0.06 && event.midi >= 36 && event.midi <= 96)
    .sort((left, right) => left.startTime - right.startTime);

  if (!detectedNotes.length) return null;

  const beatUnitSeconds = clamp(
    estimateBeatUnitSeconds(detectedNotes.map((event) => event.duration)),
    0.24,
    0.95
  );
  const notes = detectedNotes.map((event) => {
    const quantized = quantizeSecondsToBeats(event.duration, beatUnitSeconds, "soft");
    return {
      ...createNote(event.midi, quantized.beats, beatUnitSeconds, event.duration, {
        frequency: midiToFreq(event.midi),
        startTime: event.startTime,
        endTime: event.startTime + event.duration
      }),
      phraseId: event.phraseId,
      phraseStart: event.phraseStart ?? event.startTime,
      phraseEnd: event.phraseEnd ?? event.startTime + event.duration,
      hasBreathBefore: event.hasBreathBefore,
      hasBreathAfter: event.hasBreathAfter
    };
  });
  const averageAmplitude = detectedNotes.reduce((total, event) => total + event.amplitude, 0) / detectedNotes.length;
  const confidence = Math.round(clamp(averageAmplitude * 66 + Math.min(24, notes.length * 3), 55, 97));

  return {
    title,
    analysis: `真实录音转译 · Basic Pitch 音高与起音识别 · 人声后处理 v2 · ${notes.length} 个音符 · 识别置信度 ${confidence}% · ${Math.round(60 / beatUnitSeconds)} BPM`,
    beatUnitSeconds,
    confidence,
    tempo: Math.round(60 / beatUnitSeconds),
    notes
  };
}

function makeVoiceEnvelope(context, when, attack, hold, release, peak, destination = context.destination) {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + attack);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.58, 0.08), when + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
  gain.connect(destination);
  return gain;
}

function buildInstrumentVoice(context, instrument, frequency, when, duration, articulation = "legato", phraseRole = "single", destination = context.destination) {
  const envelopeMap = {
    Piano: {
      attack: 0.01,
      hold: Math.max(duration * 0.35, 0.08),
      release: 0.34,
      peak: 0.3,
      types: ["triangle", "sine"],
      detune: [0, 12]
    },
    Guitar: {
      attack: 0.005,
      hold: Math.max(duration * 0.2, 0.05),
      release: 0.28,
      peak: 0.24,
      types: ["triangle", "triangle"],
      detune: [0, 7]
    },
    Flute: {
      attack: 0.05,
      hold: Math.max(duration * 0.6, 0.18),
      release: 0.22,
      peak: 0.18,
      types: ["sine", "sine"],
      detune: [0, 12]
    },
    Violin: {
      attack: 0.08,
      hold: Math.max(duration * 0.7, 0.2),
      release: 0.24,
      peak: 0.2,
      types: ["sawtooth", "triangle"],
      detune: [0, -5]
    },
    Mallet: {
      attack: 0.004,
      hold: Math.max(duration * 0.12, 0.035),
      release: 0.13,
      peak: 0.18,
      types: ["sine", "triangle"],
      detune: [0, 7]
    }
  };

  const recipe = envelopeMap[instrument] || envelopeMap.Piano;
  const isLegato = articulation === "legato";
  const isPhraseStart = phraseRole === "start" || phraseRole === "single";
  const isPhraseEnd = phraseRole === "end" || phraseRole === "single";
  // Internal notes do not fully release and re-attack. Phrase edges keep each
  // instrument's natural character while pitch changes crossfade smoothly.
  const attack = isLegato ? (isPhraseStart ? recipe.attack : Math.min(recipe.attack, 0.012)) : recipe.attack;
  const hold = isLegato ? Math.max(duration * (isPhraseEnd ? 0.72 : 0.96), duration - (isPhraseEnd ? 0.055 : 0.018)) : recipe.hold;
  const release = isLegato ? (isPhraseEnd ? recipe.release : 0.045) : recipe.release;
  const gain = makeVoiceEnvelope(context, when, attack, hold, release, recipe.peak, destination);
  const filter = context.createBiquadFilter();
  filter.type = instrument === "Flute" ? "lowpass" : "bandpass";
  filter.frequency.setValueAtTime(
    instrument === "Violin" ? 2100 : instrument === "Flute" ? 2600 : instrument === "Mallet" ? 2500 : 1800,
    when
  );
  filter.Q.setValueAtTime(instrument === "Guitar" || instrument === "Mallet" ? 1.5 : 0.8, when);
  filter.connect(gain);

  const oscillators = recipe.types.map((type, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(
      frequency * Math.pow(2, recipe.detune[index] / 1200),
      when
    );
    oscillator.connect(filter);
    oscillator.start(when);
    oscillator.stop(when + attack + hold + release + 0.05);
    return oscillator;
  });

  let lfo = null;
  if (instrument === "Flute" || instrument === "Violin") {
    lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.setValueAtTime(instrument === "Violin" ? 5.4 : 4.6, when);
    lfoGain.gain.setValueAtTime(instrument === "Violin" ? 6 : 4, when);
    lfo.connect(lfoGain);
    oscillators.forEach((oscillator) => lfoGain.connect(oscillator.frequency));
    lfo.start(when);
    lfo.stop(when + attack + hold + release + 0.05);
  }

  return { gain, oscillators, lfo };
}

function getInstrumentOutput(context, audioState) {
  if (audioState.instrumentOutput?.context === context) return audioState.instrumentOutput;
  const output = context.createGain();
  const limiter = context.createDynamicsCompressor();
  // The shared output prevents phrase overlaps from clipping while keeping each instrument level consistent.
  output.gain.setValueAtTime(0.58, context.currentTime);
  limiter.threshold.setValueAtTime(-16, context.currentTime);
  limiter.knee.setValueAtTime(12, context.currentTime);
  limiter.ratio.setValueAtTime(8, context.currentTime);
  limiter.attack.setValueAtTime(0.004, context.currentTime);
  limiter.release.setValueAtTime(0.12, context.currentTime);
  output.connect(limiter);
  limiter.connect(context.destination);
  audioState.instrumentOutput = output;
  audioState.instrumentLimiter = limiter;
  return output;
}

function destroyInstrumentOutput(audioState) {
  try { audioState.sampledInstrumentEngine?.destroy(); } catch { /* release failures are non-fatal */ }
  try { audioState.instrumentOutput?.disconnect(); } catch { /* already disconnected */ }
  try { audioState.instrumentLimiter?.disconnect(); } catch { /* already disconnected */ }
  audioState.activeSampleStops = [];
  audioState.sampledInstrumentEngine = null;
  audioState.sampledInstrumentContext = null;
  audioState.instrumentOutput = null;
  audioState.instrumentLimiter = null;
}

function unlockInstrumentOutput(context, audioState) {
  if (audioState.instrumentOutputUnlocked) return;

  // A near-silent source started from the tap unlocks Web Audio output in iOS Safari/PWA.
  const unlockGain = context.createGain();
  const unlockOscillator = context.createOscillator();
  unlockGain.gain.setValueAtTime(0.00001, context.currentTime);
  unlockOscillator.frequency.setValueAtTime(440, context.currentTime);
  unlockOscillator.connect(unlockGain);
  unlockGain.connect(context.destination);
  unlockOscillator.start(context.currentTime);
  unlockOscillator.stop(context.currentTime + 0.02);
  audioState.instrumentOutputUnlocked = true;
}

const initialAudioState = () => ({
  audioContext: null,
  mediaStream: null,
  mediaRecorder: null,
  mediaSource: null,
  processorNode: null,
  analyserNode: null,
  silenceGain: null,
  recordStartTime: 0,
  pitchFrames: [],
  stableFrameCount: 0,
  lastCapturedFrames: [],
  recordedChunks: [],
  recordedBlob: null,
  recordedUrl: "",
  tunedBlob: null,
  tunedUrl: "",
  sourceName: "",
  sourceKind: "",
  sourceDuration: 0,
  recordElapsedBeforePause: 0,
  recordStartedAt: 0,
  recordTimer: null,
  metronomeScheduler: null,
  metronomeTiming: null,
  metronomeDiagnostics: [],
  playTimeouts: [],
  activeVoices: [],
  activeSampleStops: [],
  sampledInstrumentEngine: null,
  sampledInstrumentContext: null,
  instrumentOutput: null,
  instrumentLimiter: null,
  instrumentOutputUnlocked: false,
  realtimePitchTracker: null
});

function LegacyApp() {
  const [melody, setMelody] = useState(() => deepClone(demoMelodies[0]));
  const [demoIndex, setDemoIndex] = useState(0);
  const [selectedNote, setSelectedNote] = useState(0);
  const [currentView, setCurrentView] = useState("staff");
  const [instrument, setInstrument] = useState("Piano");
  const [arrangement, setArrangement] = useState("piano-ballad");
  const [recording, setRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [livePitch, setLivePitch] = useState("--");
  const [stableFrames, setStableFrames] = useState(0);
  const [statusMessage, setStatusMessage] = useState(
    "当前建议：先录一段尽量单线条、没有太多滑音的旋律，再转成曲谱试听。"
  );
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [playingIndex, setPlayingIndex] = useState(-1);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const [secureHint, setSecureHint] = useState(
    "如果浏览器不让你开麦克风，请不要直接双击 HTML，用 localhost 打开这个页面。"
  );
  const [secureHintError, setSecureHintError] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installBannerDismissed, setInstallBannerDismissed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("hummely-install-dismissed") === "1";
  });
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [mobileStep, setMobileStep] = useState("capture");

  const toastTimerRef = useRef(null);
  const audioRef = useRef(initialAudioState());
  const pendingTranscribeRef = useRef(false);

  const notes = melody.notes || [];
  const selectedNoteData = notes[selectedNote] || null;

  useEffect(() => {
    if (selectedNote >= notes.length) {
      setSelectedNote(Math.max(0, notes.length - 1));
    }
  }, [notes.length, selectedNote]);

  useEffect(() => {
    if (!window.isSecureContext && location.protocol !== "file:") {
      setSecureHintError(true);
      setSecureHint("当前页面不是安全上下文。麦克风通常只会在 https 或 localhost 下工作。");
    }
  }, []);

  useEffect(() => {
    const displayModeMedia = window.matchMedia("(display-mode: standalone)");
    const isAppleMobile =
      /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

    const syncDisplayMode = () => {
      setIsStandalone(displayModeMedia.matches || window.navigator.standalone === true);
    };

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setInstallBannerDismissed(false);
    };

    const handleInstalled = () => {
      setDeferredInstallPrompt(null);
      setIsStandalone(true);
      setInstallBannerDismissed(true);
      window.localStorage.setItem("hummely-install-dismissed", "1");
      showToast("Hummely 已添加到设备");
    };

    syncDisplayMode();
    setIsIos(isAppleMobile);

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    displayModeMedia.addEventListener?.("change", syncDisplayMode);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      displayModeMedia.removeEventListener?.("change", syncDisplayMode);
    };
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
      cleanupRecorderGraph();
      if (audioRef.current.recordedUrl) {
        URL.revokeObjectURL(audioRef.current.recordedUrl);
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  function showToast(message) {
    setToastMessage(message);
    setToastVisible(true);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 2200);
  }

  function dismissInstallBanner() {
    setInstallBannerDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("hummely-install-dismissed", "1");
    }
  }

  async function handleInstallApp() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setStatusMessage("安装请求已发送给浏览器。安装完成后，Hummely 会像原生 APP 一样出现在你的桌面。");
        showToast("正在安装 Hummely");
      } else {
        setStatusMessage("这次先继续用网页版本也没问题。你随时都可以再点一次，把 Hummely 安装到桌面。");
      }
      setDeferredInstallPrompt(null);
      return;
    }

    if (isIos) {
      setShowIosSteps((current) => !current);
      setStatusMessage("iPhone 或 iPad 上请用 Safari 打开，然后点分享，再选“添加到主屏幕”。");
      return;
    }

    setStatusMessage("当前浏览器没有直接弹出安装按钮。你可以打开浏览器菜单，查找“安装应用”或“添加到桌面”。");
    showToast("请从浏览器菜单安装");
  }

  async function ensureAudioContext() {
    const audioState = audioRef.current;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      throw new Error("当前浏览器不支持乐器试听。");
    }

    // iOS can close an AudioContext after an interruption, such as switching apps.
    if (!audioState.audioContext || audioState.audioContext.state === "closed") {
      audioState.audioContext = new Context({ latencyHint: "interactive" });
      audioState.instrumentOutputUnlocked = false;
    }

    let context = audioState.audioContext;
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch (error) {
        throw new Error("浏览器没有允许乐器声音播放。");
      }
    }

    // Safari may keep an interrupted context suspended after resume. Recreate it once
    // rather than scheduling a melody that looks active but cannot reach the speaker.
    if (context.state === "interrupted") {
      try {
        await context.close();
      } catch (error) {
        // Closing an interrupted context is best-effort before creating a clean output.
      }
      context = new Context({ latencyHint: "interactive" });
      audioState.audioContext = context;
      audioState.instrumentOutputUnlocked = false;
      try {
        await context.resume();
      } catch (error) {
        throw new Error("浏览器没有允许乐器声音播放。");
      }
    }

    if (context.state !== "running") {
      throw new Error("乐器声音被系统暂时中断，请再点一次播放。");
    }

    return context;
  }

  function cleanupRecorderGraph() {
    const audioState = audioRef.current;
    if (audioState.processorNode) {
      audioState.processorNode.disconnect();
      audioState.processorNode.onaudioprocess = null;
      audioState.processorNode = null;
    }
    if (audioState.mediaSource) {
      audioState.mediaSource.disconnect();
      audioState.mediaSource = null;
    }
    if (audioState.silenceGain) {
      audioState.silenceGain.disconnect();
      audioState.silenceGain = null;
    }
    if (audioState.mediaStream) {
      audioState.mediaStream.getTracks().forEach((track) => track.stop());
      audioState.mediaStream = null;
    }
  }

  function stopPlayback() {
    const audioState = audioRef.current;
    if (!audioState.audioContext) {
      setPlayingIndex(-1);
      return;
    }
    audioState.playTimeouts.forEach((timer) => clearTimeout(timer));
    audioState.playTimeouts = [];
    audioState.activeVoices.forEach((voice) => {
      try {
        voice.gain.gain.cancelScheduledValues(audioState.audioContext.currentTime);
        voice.gain.gain.setTargetAtTime(0.0001, audioState.audioContext.currentTime, 0.03);
        voice.oscillators.forEach((oscillator) =>
          oscillator.stop(audioState.audioContext.currentTime + 0.08)
        );
        if (voice.lfo) {
          voice.lfo.stop(audioState.audioContext.currentTime + 0.08);
        }
      } catch (error) {
        // ignore stop race
      }
    });
    audioState.activeVoices = [];
    setPlayingIndex(-1);
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setSecureHintError(true);
      setSecureHint("这个浏览器环境不支持麦克风接口。请用 Safari 或 Chrome 并通过 localhost 打开页面。");
      setStatusMessage("当前环境不支持麦克风录音，建议切到支持 getUserMedia 的浏览器。");
      return;
    }

    try {
      await ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1
        }
      });

      setSecureHintError(false);
      setSecureHint("录音已就绪。结束录音后，页面会自动把最新哼唱转成音符，并可直接用乐器试听。");

      const audioState = audioRef.current;
      const context = audioState.audioContext;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      const silenceGain = context.createGain();
      silenceGain.gain.value = 0;

      audioState.mediaStream = stream;
      audioState.mediaSource = source;
      audioState.processorNode = processor;
      audioState.silenceGain = silenceGain;
      audioState.pitchFrames = [];
      audioState.stableFrameCount = 0;
      audioState.recordedChunks = [];
      audioState.recordStartTime = performance.now();

      source.connect(processor);
      processor.connect(silenceGain);
      silenceGain.connect(context.destination);

      processor.onaudioprocess = (event) => {
        const buffer = event.inputBuffer.getChannelData(0);
        const sample = new Float32Array(buffer);
        const analysis = estimatePitchYin(sample, context.sampleRate);
        const time = (performance.now() - audioState.recordStartTime) / 1000;
        audioState.pitchFrames.push({
          time,
          frequency: analysis.frequency,
          clarity: analysis.clarity,
          rms: analysis.rms
        });

        if (analysis.frequency && analysis.clarity > 0.54 && analysis.rms > 0.006) {
          audioState.stableFrameCount += 1;
        }

        setRecordDuration(time);
        setStableFrames(audioState.stableFrameCount);
        setLivePitch(
          analysis.frequency ? midiToPitchName(Math.round(freqToMidi(analysis.frequency))) : "--"
        );
      };

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioState.recordedChunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        cleanupRecorderGraph();
        const duration = (performance.now() - audioState.recordStartTime) / 1000;
        setRecordDuration(duration);

        if (!audioState.recordedChunks.length) {
          setStatusMessage("录音结束了，但没有拿到有效音频数据。请再试一次。");
          return;
        }

        const blob = new Blob(audioState.recordedChunks, { type: recorder.mimeType || "audio/webm" });
        audioState.recordedBlob = blob;
        if (audioState.recordedUrl) {
          URL.revokeObjectURL(audioState.recordedUrl);
        }
        audioState.recordedUrl = URL.createObjectURL(blob);
        setVoicePreviewUrl(audioState.recordedUrl);
        audioState.lastCapturedFrames = [...audioState.pitchFrames];
        setStatusMessage("录音已保存。你可以直接点击“转译最新录音”，或者继续录一遍更稳定的版本。");
        showToast("录音已完成");

        if (pendingTranscribeRef.current) {
          pendingTranscribeRef.current = false;
          setTimeout(() => {
            void transcribeLatestRecording(audioState.lastCapturedFrames);
          }, 0);
        }
      };

      recorder.start(180);
      audioState.mediaRecorder = recorder;
      setRecording(true);
      setRecordDuration(0);
      setStableFrames(0);
      setLivePitch("--");
      setStatusMessage("正在录音。尽量保持单旋律，少一点气音和环境噪声，识别会更稳定。");
      showToast("录音开始");
    } catch (error) {
      setSecureHintError(true);
      setSecureHint("麦克风没有成功打开。最常见的原因是浏览器权限没允许，或页面不是通过 localhost / https 打开的。");
      setStatusMessage(`麦克风开启失败：${error.message || "请检查权限"}`);
    }
  }

  function stopRecording() {
    const audioState = audioRef.current;
    if (!recording) {
      return;
    }
    setRecording(false);
    if (audioState.mediaRecorder && audioState.mediaRecorder.state !== "inactive") {
      audioState.mediaRecorder.stop();
    } else {
      cleanupRecorderGraph();
    }
  }

  function syncNoteData(note, beatUnitSeconds) {
    return createNote(
      note.midi,
      note.beats,
      beatUnitSeconds,
      note.noteSeconds || note.beats * beatUnitSeconds
    );
  }

  function changePitch(delta) {
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      if (!note) {
        return current;
      }
      note.midi = clamp(note.midi + delta, 48, 84);
      Object.assign(note, syncNoteData(note, next.beatUnitSeconds || 0.55));
      return next;
    });
    const current = notes[selectedNote];
    if (current) {
      const nextMidi = clamp(current.midi + delta, 48, 84);
      setStatusMessage(`已将第 ${selectedNote + 1} 个音调整为 ${midiToPitchName(nextMidi)}。建议试听确认这个位置是否更接近你原本的旋律。`);
    }
  }

  function changeDuration(delta) {
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      if (!note) {
        return current;
      }
      const currentIndex = durationOptions.findIndex((item) => item.beats === note.beats);
      const nextIndex = clamp(currentIndex + delta, 0, durationOptions.length - 1);
      note.beats = durationOptions[nextIndex].beats;
      note.duration = durationOptions[nextIndex].label;
      note.noteSeconds = note.beats * (next.beatUnitSeconds || 0.55);
      Object.assign(note, syncNoteData(note, next.beatUnitSeconds || 0.55));
      return next;
    });

    const current = notes[selectedNote];
    if (current) {
      const currentIndex = durationOptions.findIndex((item) => item.beats === current.beats);
      const nextIndex = clamp(currentIndex + delta, 0, durationOptions.length - 1);
      setStatusMessage(`已把第 ${selectedNote + 1} 个音改为${durationOptions[nextIndex].label}音符。谱面已经同步更新。`);
    }
  }

  function autoSnapMelody() {
    if (!notes.length) {
      return;
    }
    setMelody((current) => {
      const next = deepClone(current);
      next.notes = next.notes.map((note) => {
        const snapped = quantizeSecondsToBeats(
          note.noteSeconds || note.beats * (next.beatUnitSeconds || 0.55),
          next.beatUnitSeconds || 0.55
        );
        return createNote(
          note.midi,
          snapped.beats,
          next.beatUnitSeconds || 0.55,
          snapped.beats * (next.beatUnitSeconds || 0.55)
        );
      });
      return next;
    });
    setStatusMessage("自动吸附已执行：系统把每个音符时值吸附到了最接近的常用拍值。");
    showToast("已完成自动吸附");
  }

  async function transcribeLatestRecording(frameOverride) {
    const audioState = audioRef.current;
    const targetFrames = frameOverride || audioState.lastCapturedFrames;

    if (!targetFrames.length) {
      setStatusMessage("还没有最新录音可以转译。请先按下录音按钮，哼完后再点一次结束。");
      showToast("请先录一段旋律");
      return;
    }

    const title = melody.title?.trim() || `新旋律 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const realtimeMelody = buildMelodyFromFrames(targetFrames, title);
    let offlineMelody = null;

    if (audioState.recordedBlob) {
      try {
        const context = await ensureAudioContext();
        const offlineFrames = await extractFramesFromBlob(audioState.recordedBlob, context);
        offlineMelody = buildMelodyFromFrames(offlineFrames, title);
      } catch (error) {
        console.warn("Offline pitch analysis failed:", error);
      }
    }

    const transcribedMelody = [realtimeMelody, offlineMelody]
      .filter(Boolean)
      .sort((left, right) => scoreMelodyCandidate(right) - scoreMelodyCandidate(left))[0];

    if (!transcribedMelody) {
      const liveFrameCount = targetFrames.filter((frame) => frame.frequency).length;
      setStatusMessage(
        `这次没有识别到足够稳定的音高。录音帧数 ${targetFrames.length}，有效音高帧 ${liveFrameCount}。建议靠近麦克风、减少背景噪声，并尽量用单旋律连续哼唱。`
      );
      showToast("识别失败，再录一遍试试");
      return;
    }

    setMelody(transcribedMelody);
    setSelectedNote(0);
    setMobileStep("score");
    const usedOffline = transcribedMelody === offlineMelody;
    setStatusMessage(
      `转译完成：识别出 ${transcribedMelody.notes.length} 个音符。${
        usedOffline ? "已使用整段录音复核，快速短音会优先保留。" : "实时分析结果已足够稳定。"
      }`
    );
    showToast("最新录音已转成曲谱");
  }

  function loadDemoMelody() {
    const nextIndex = demoIndex === 0 ? 1 : 0;
    setDemoIndex(nextIndex);
    setMelody(deepClone(demoMelodies[nextIndex]));
    setSelectedNote(0);
    setStatusMessage("已切换到示例旋律。你可以先试玩转谱后的编辑与乐器试听，再录自己的旋律。");
    showToast("已切换示例旋律");
  }

  async function playMelody() {
    if (!notes.length) {
      showToast("还没有可播放的旋律");
      return;
    }

    const context = await ensureAudioContext();
    stopPlayback();
    setStatusMessage(`正在用 ${instrument} 试听当前旋律。你也可以先听原始录音，再对比转译后的结果。`);

    const audioState = audioRef.current;
    const startTime = context.currentTime + 0.06;
    let cursor = startTime;

    notes.forEach((note, index) => {
      const noteLength = Math.max(0.12, note.noteSeconds || note.beats * (melody.beatUnitSeconds || 0.55));
      const voice = buildInstrumentVoice(context, instrument, midiToFreq(note.midi), cursor, noteLength);
      audioState.activeVoices.push(voice);

      audioState.playTimeouts.push(
        setTimeout(() => setPlayingIndex(index), Math.max(0, (cursor - context.currentTime) * 1000))
      );

      cursor += noteLength;
    });

    audioState.playTimeouts.push(
      setTimeout(() => {
        stopPlayback();
        setStatusMessage("试听完成。现在你可以继续修音，或者切换别的乐器再听一遍。");
      }, Math.max(0, (cursor - context.currentTime) * 1000 + 140))
    );
  }

  const totalBeats = notes.reduce((sum, note) => sum + note.beats, 0);
  const measureCount = Math.max(1, Math.ceil(totalBeats / 4));
  const shouldShowInstallBanner = !isStandalone && !installBannerDismissed;
  const installSummary = deferredInstallPrompt
    ? "浏览器已经允许安装。点一下就能把它固定到手机桌面，录旋律时会更像真正的创作 APP。"
    : isIos
      ? "iPhone / iPad 上可以直接加到主屏幕。安装后会全屏启动，更接近原生 APP 的使用感受。"
      : "这版已经具备 APP 壳。等你部署到线上后，用户就能通过浏览器菜单安装到桌面。";

  return (
    <>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">♪</div>
            <div className="brand-copy">
              <h1>Hummely</h1>
              <p>把脑海里的旋律，变成一页可听的曲谱。</p>
            </div>
          </div>
          <div className="top-actions">
            <div className="pill">单旋律工作台</div>
            <div className="pill">{isStandalone ? "APP 模式" : "网页模式"}</div>
          </div>
        </header>

        {shouldShowInstallBanner ? (
          <section className="install-banner">
            <div className="install-copy">
              <div className="pill inline-pill">现在已经是 APP 形态</div>
              <h3>把 Hummely 安装到手机桌面，随时接住灵感。</h3>
              <p>{installSummary}</p>
              <div className="install-actions">
                <button className="action-btn compact" onClick={handleInstallApp}>
                  {deferredInstallPrompt ? "安装 APP" : isIos ? "查看 iPhone 安装步骤" : "查看安装方式"}
                </button>
                <button className="ghost-btn compact" onClick={dismissInstallBanner}>
                  稍后再说
                </button>
              </div>
              {showIosSteps ? (
                <div className="install-steps">
                  <strong>iPhone 安装步骤</strong>
                  <span>1. 用 Safari 打开这个页面</span>
                  <span>2. 点击底部或顶部的分享按钮</span>
                  <span>3. 选择“添加到主屏幕”</span>
                </div>
              ) : null}
            </div>

            <div className="install-points">
              <div className="install-point">
                <strong>全屏启动</strong>
                <span>弱化浏览器感，更像真正的创作工具。</span>
              </div>
              <div className="install-point">
                <strong>桌面入口</strong>
                <span>想到旋律时不用先找网址，点开就能录。</span>
              </div>
              <div className="install-point">
                <strong>离线壳</strong>
                <span>基础界面会被缓存，下次打开更快更稳。</span>
              </div>
            </div>
          </section>
        ) : null}

        <section className="hero">
          <div className="hero-card">
            <div className="hero-orb" aria-hidden="true" />
            <div className="pill inline-pill">从哼唱到乐谱，只保留创作的流感</div>
            <h2>想到旋律就哼出来，APP 帮你接住灵感。</h2>
            <p>
              这版已经升级成可安装的 PWA APP，支持真实麦克风录音、浏览器端转谱、简谱与五线谱切换、音符微调，以及合成乐器试听。
            </p>
            <div className="hero-row">
              <div className="chip">哼唱识别</div>
              <div className="chip">简谱 / 五线谱</div>
              <div className="chip">音高修正</div>
              <div className="chip">乐器试听</div>
              <div className="chip">AI 编曲建议</div>
            </div>
          </div>

          <div className="hero-card">
            <div className="stat-grid">
              <div className="stat">
                <div className="stat-label">当前识别模式</div>
                <div className="stat-value">单旋律</div>
                <div className="stat-note">先让用户成功把脑中的旋律落下来</div>
              </div>
              <div className="stat">
                <div className="stat-label">输出格式</div>
                <div className="stat-value">3</div>
                <div className="stat-note">简谱 / 五线谱 / MIDI 导出</div>
              </div>
              <div className="stat">
                <div className="stat-label">可修正维度</div>
                <div className="stat-value">音高</div>
                <div className="stat-note">后续可扩展到节奏、力度、拍号</div>
              </div>
              <div className="stat">
                <div className="stat-label">即时试听</div>
                <div className="stat-value">4</div>
                <div className="stat-note">钢琴、吉他、长笛、小提琴</div>
              </div>
            </div>
          </div>
        </section>

        <section className="studio" data-mobile-step={mobileStep}>
          <aside className="panel mobile-panel capture-panel">
            <h3>1. 灵感录入</h3>
            <p className="sub">
              现在这一版已经可以真实调用麦克风录音，并在浏览器里把你的哼唱切成音符序列。保留示例旋律只是为了方便演示对比。
            </p>

            <div className="stack">
              <div className="recorder">
                <div className={`record-ring${recording ? " recording" : ""}`}>
                  <button
                    className="record-btn"
                    id="recordBtn"
                    aria-label={recording ? "停止录音" : "开始录音"}
                    onClick={() => {
                      if (recording) {
                        stopRecording();
                      } else {
                        startRecording();
                      }
                    }}
                  >
                    {recording ? "■" : "●"}
                  </button>
                </div>

                <div className="recorder-copy">
                  <strong>{recording ? "正在捕捉你的旋律..." : "点击开始哼唱"}</strong>
                  <span>
                    {recording
                      ? "系统正在实时检测音高与稳定度，结束后会自动转成谱子"
                      : "建议先哼 4 到 12 秒，尽量保持单旋律、环境安静"}
                  </span>
                </div>

                <div className={`wave${recording ? " live" : ""}`}>
                  {Array.from({ length: 9 }).map((_, index) => (
                    <span
                      // eslint-disable-next-line react/no-array-index-key
                      key={index}
                      style={{
                        "--size": [2, 4, 6, 3, 7, 5, 4, 6, 3][index],
                        "--index": index
                      }}
                    />
                  ))}
                </div>
              </div>

              <div className="capture-stats">
                <div className="capture-stat">
                  <span>录音长度</span>
                  <strong>{recordDuration.toFixed(1)}s</strong>
                </div>
                <div className="capture-stat">
                  <span>实时音高</span>
                  <strong>{livePitch}</strong>
                </div>
                <div className="capture-stat">
                  <span>稳定音帧</span>
                  <strong>{stableFrames}</strong>
                </div>
              </div>

              <audio
                className={`audio-preview${voicePreviewUrl ? " ready" : ""}`}
                controls
                preload="metadata"
                src={voicePreviewUrl || undefined}
              />

              <p className={`helper-text${secureHintError ? " error" : ""}`}>{secureHint}</p>

              <div className="meta-grid">
                <div className="field">
                  <label htmlFor="ideaName">旋律名称</label>
                  <input
                    id="ideaName"
                    value={melody.title}
                    onChange={(event) =>
                      setMelody((current) => ({
                        ...current,
                        title: event.target.value
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="moodSelect">情绪方向</label>
                  <select id="moodSelect" defaultValue="温暖抒情">
                    <option>温暖抒情</option>
                    <option>电影感</option>
                    <option>民谣轻快</option>
                    <option>Lo-fi 慵懒</option>
                  </select>
                </div>
              </div>

              <button
                className="action-btn"
                onClick={() => {
                  if (recording) {
                    pendingTranscribeRef.current = true;
                    stopRecording();
                  } else {
                    void transcribeLatestRecording();
                  }
                }}
              >
                转译最新录音
              </button>
              <button className="ghost-btn" onClick={loadDemoMelody}>
                切换另一段示例旋律
              </button>
            </div>
          </aside>

          <main className="panel center-panel mobile-panel score-panel">
            <div className="center-head">
              <div>
                <h3>2. 曲谱工作台</h3>
                <p className="sub">
                  先自动落谱，再让用户在最小心智负担下去修音。点击音符后，右侧会同步出现修正工具。
                </p>
              </div>

              <div className="segment" aria-label="谱面切换">
                <button
                  className={currentView === "staff" ? "active" : ""}
                  onClick={() => setCurrentView("staff")}
                >
                  五线谱
                </button>
                <button
                  className={currentView === "numbered" ? "active" : ""}
                  onClick={() => setCurrentView("numbered")}
                >
                  简谱
                </button>
              </div>
            </div>

            <div className="timeline">
              {["录音", "识别音高", "切分节奏", "量化成谱", "人工修正", "试听", "编曲建议", "导出"].map(
                (label, index) => (
                  <div
                    className={`timeline-step${index < 4 ? " active" : ""}`}
                    key={label}
                  >
                    {label}
                  </div>
                )
              )}
            </div>

            <div className={`score-surface${currentView === "numbered" ? " numbered" : ""}`}>
              <div className="score-legend">
                <span>
                  <strong>{melody.title || "未命名旋律"}</strong> · 4/4 · Key of C ·{" "}
                  <span>{instrument}</span>
                </span>
                <span>{melody.analysis}</span>
              </div>

              {currentView === "staff" ? (
                <div className="note-area">
                  {Array.from({ length: Math.max(0, measureCount - 1) }).map((_, index) => (
                    <div
                      className="measure"
                      key={`measure-${index + 1}`}
                      style={{ left: `${((index + 1) / measureCount) * 100}%` }}
                    />
                  ))}

                  {notes.length ? (
                    notes.map((note, index) => {
                      const previousBeats = notes
                        .slice(0, index)
                        .reduce((sum, current) => sum + current.beats, 0);
                      const centerBeat = previousBeats + note.beats / 2;
                      const leftPercent = totalBeats ? 4 + (centerBeat / totalBeats) * 88 : 8 + index * 10;
                      const top = clamp(214 - (note.midi - 55) * 11, 16, 220);

                      return (
                        <button
                          className={`staff-note${
                            selectedNote === index ? " selected" : ""
                          }${playingIndex === index ? " playing" : ""}`}
                          data-duration={note.duration}
                          key={`${note.midi}-${index}`}
                          style={{ left: `calc(${leftPercent}% - 18px)`, top: `${top}px` }}
                          onClick={() => {
                            setSelectedNote(index);
                            setMobileStep("refine");
                          }}
                        >
                          {note.solfege}
                        </button>
                      );
                    })
                  ) : (
                    <p className="empty-copy">还没有识别到旋律。先录音，或者切换示例旋律。</p>
                  )}
                </div>
              ) : (
                <div className="notation-grid show">
                  {notes.map((note, index) => (
                    <div className="notation-card" key={`${note.jianpu}-${index}`}>
                      <strong>{note.jianpu}</strong>
                      <span>
                        {note.solfege} · {midiToPitchName(note.midi)} · {note.duration}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </main>

          <aside className="panel mobile-panel refine-panel">
            <h3>3. 修正与试听</h3>
            <p className="sub">
              右侧是给非专业用户的轻量编辑台，不需要懂复杂乐理，也能把旋律修到自己想要的样子。
            </p>

            <div className="stack">
              <div className="edit-box">
                <div className="note-detail">
                  <strong>
                    当前选中：{selectedNoteData ? selectedNoteData.solfege : "无"}
                  </strong>
                  <span>
                    {selectedNoteData
                      ? `音高 ${midiToPitchName(selectedNoteData.midi)} · 时值 ${selectedNoteData.duration}音符`
                      : "先录一段旋律，或者切换示例旋律"}
                  </span>
                </div>
                <div className="edit-row">
                  <button className="tiny-btn" onClick={() => changePitch(1)}>
                    升高半音
                  </button>
                  <button className="tiny-btn" onClick={() => changePitch(-1)}>
                    降低半音
                  </button>
                </div>
                <div className="edit-row">
                  <button className="tiny-btn" onClick={() => changeDuration(1)}>
                    延长时值
                  </button>
                  <button className="tiny-btn" onClick={() => changeDuration(-1)}>
                    缩短时值
                  </button>
                </div>
              </div>

              <div>
                <h4 className="side-title">乐器试听</h4>
                <div className="instrument-list">
                  {[
                    ["Piano", "钢琴", "最适合先确认主旋律和音准"],
                    ["Guitar", "木吉他", "适合民谣、流行 demo 的灵感试听"],
                    ["Flute", "长笛", "更容易检查旋律线条是否流畅"],
                    ["Violin", "小提琴", "更适合抒情与影视感的旋律质感"]
                  ].map(([value, label, description]) => (
                    <button
                      className={`instrument${instrument === value ? " active" : ""}`}
                      data-instrument={value}
                      key={value}
                      onClick={() => {
                        setInstrument(value);
                        setStatusMessage(`已切换到 ${label} 试听模式。`);
                      }}
                    >
                      <strong>{label}</strong>
                      <span>{description}</span>
                    </button>
                  ))}
                </div>
                <div className="transport">
                  <button onClick={playMelody}>试听</button>
                  <button className="secondary" onClick={stopPlayback}>
                    停止
                  </button>
                  <button className="secondary" onClick={autoSnapMelody}>
                    自动吸附
                  </button>
                </div>
              </div>

              <div>
                <h4 className="side-title">AI 编曲建议</h4>
                <div className="arrangement-list">
                  {[
                    ["piano-ballad", "钢琴抒情版", "主和弦走向 C - Am - F - G，适合先做情绪 demo"],
                    ["folk-pop", "民谣流行版", "加入木吉他分解和弦与轻鼓点，适合副歌发展"],
                    ["cinematic", "影视配乐版", "保留主旋律，底部加铺底弦乐和轻打击增强起伏"]
                  ].map(([value, label, description]) => (
                    <button
                      className={`arrangement-card${arrangement === value ? " active" : ""}`}
                      key={value}
                      onClick={() => {
                        setArrangement(value);
                        setStatusMessage(arrangementAdvice[value]);
                      }}
                    >
                      <strong>{label}</strong>
                      <span>{description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="status">{statusMessage}</div>
            </div>
          </aside>
        </section>

        <nav className="mobile-nav" aria-label="创作步骤">
          {[
            ["capture", "●", "录音"],
            ["score", "♫", "曲谱"],
            ["refine", "✦", "修正"]
          ].map(([step, icon, label]) => (
            <button
              className={mobileStep === step ? "active" : ""}
              key={step}
              onClick={() => setMobileStep(step)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        <section className="bottom-grid">
          <div className="mini-panel">
            <h4>核心体验路径</h4>
            <p>
              这版先验证灵感能不能顺利落地，再慢慢往真正的作曲工具扩。现在项目已经是标准 React 结构，后面继续拆组件会轻松很多。
            </p>
            <div className="journey">
              {[
                ["1", "哼唱捕捉", "快速录入旋律，不要求用户懂拍号、调式或和弦。"],
                ["2", "自动转谱", "输出五线谱和简谱两种视觉，让不同背景的人都能看懂。"],
                ["3", "轻量修音", "只暴露最必要的操作，降低不会乐理的人对编辑器的恐惧。"],
                ["4", "试听与编曲", "用乐器试听和 AI 建议帮助用户继续推进灵感。"]
              ].map(([step, title, description]) => (
                <div className="journey-step" key={step}>
                  <b>{step}</b>
                  <strong>{title}</strong>
                  <span>{description}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mini-panel">
            <h4>导出与后续扩展</h4>
            <p>
              现在已经有了适合长期开发的工程基础。下一步可以继续接 MIDI 导出、MusicXML、后端模型调用，或者把转谱精度再提一版。
            </p>
            <div className="export-row">
              {["MIDI", "MusicXML", "PDF"].map((item) => (
                <button className="export-chip" key={item} onClick={() => showToast(`${item} 导出是下一步很适合接上的能力`)}>
                  导出 {item}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className={`toast${toastVisible ? " show" : ""}`}>{toastMessage}</div>
    </>
  );
}

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function sourceLabel(kind) {
  return kind === "import" ? "导入的录音" : "原始哼唱";
}

function noteDurationClass(beats) {
  if (beats >= 4) return "whole";
  if (beats >= 2) return "half";
  if (beats <= 0.5) return "eighth";
  return "quarter";
}

function numberedDurationMark(beats) {
  if (beats >= 4) return "——";
  if (beats >= 2) return "—";
  if (beats <= 0.5) return "_";
  return "";
}

const scaleTemplates = [
  { name: "大调", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { name: "小调", intervals: [0, 2, 3, 5, 7, 8, 10] }
];

function inferAutoTuneScale(notes) {
  if (!notes.length) return { name: "自然音阶", pitchClasses: [0, 2, 4, 5, 7, 9, 11] };
  let best = null;
  scaleTemplates.forEach((template) => {
    for (let root = 0; root < 12; root += 1) {
      const pitchClasses = template.intervals.map((interval) => (root + interval) % 12);
      const misses = notes.reduce((total, note) => {
        const pitchClass = ((note.midi % 12) + 12) % 12;
        return total + (pitchClasses.includes(pitchClass) ? 0 : 1);
      }, 0);
      if (!best || misses < best.misses) best = { name: `${noteNames[root]} ${template.name}`, pitchClasses, misses };
    }
  });
  return best;
}

function snapMidiToScale(midi, pitchClasses) {
  let candidate = midi;
  let bestDistance = Infinity;
  for (let offset = -3; offset <= 3; offset += 1) {
    const trial = midi + offset;
    const pitchClass = ((trial % 12) + 12) % 12;
    if (pitchClasses.includes(pitchClass) && Math.abs(offset) < bestDistance) {
      candidate = trial;
      bestDistance = Math.abs(offset);
    }
  }
  return candidate;
}

function parsePitchInput(value, fallbackMidi) {
  const match = value.trim().replace(/♯/g, "#").replace(/♭/g, "b").match(/^([A-Ga-g])([#b]?)(-?\d+)?$/);
  if (!match) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()];
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const fallbackOctave = Math.floor(fallbackMidi / 12) - 1;
  const octave = match[3] === undefined ? fallbackOctave : Number(match[3]);
  const midi = (octave + 1) * 12 + base + accidental;
  return Number.isFinite(midi) && midi >= 24 && midi <= 108 ? midi : null;
}

function OriginalAudioPlayer({ url, fallbackDuration, label }) {
  const audioElementRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration || 0);

  useEffect(() => {
    const audio = audioElementRef.current;
    if (!audio) return undefined;
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
    setPosition(0);
    setDuration(fallbackDuration || 0);
    return () => audio.pause();
  }, [url, fallbackDuration]);

  if (!url) return null;

  const togglePlayback = async () => {
    const audio = audioElementRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch (error) {
        // Browsers can reject playback until the user has interacted with the page.
      }
    } else {
      audio.pause();
    }
  };

  return (
    <section className="original-player" aria-label={label}>
      <audio
        ref={audioElementRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || fallbackDuration || 0)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
      />
      <div className="original-player-head">
        <div>
          <span className="eyebrow">{label}</span>
          <strong>{label === "修音后人声" ? "试听修音后人声" : "试听原始录音"}</strong>
        </div>
        <span>{formatTime(duration)}</span>
      </div>
      <div className="original-player-controls">
        <button className="round-play" onClick={togglePlayback} aria-label={playing ? `暂停${label}` : `播放${label}`}>
          {playing ? "Ⅱ" : "▶"}
        </button>
        <input
          aria-label={`${label}播放进度`}
          type="range"
          min="0"
          max={Math.max(duration, 0.01)}
          step="0.01"
          value={Math.min(position, duration || 0)}
          onChange={(event) => {
            const audio = audioElementRef.current;
            const nextPosition = Number(event.target.value);
            if (audio) audio.currentTime = nextPosition;
            setPosition(nextPosition);
          }}
        />
        <span>{formatTime(position)}</span>
        <button
          className="text-control"
          onClick={() => {
            const audio = audioElementRef.current;
            if (!audio) return;
            audio.currentTime = 0;
            setPosition(0);
            void audio.play();
          }}
        >
          重播
        </button>
      </div>
    </section>
  );
}

function NumberedScore({ notes, rests = [], timeSignature = "4/4", selectedNote, playingIndex, onSelect, tonic = DEFAULT_TONIC }) {
  const signature = parseTimeSignature(timeSignature);
  const restByNextPhrase = new Map(rests.map((rest) => [rest.phraseBefore, rest]));
  let lastMeasure = null;
  return (
    <div className="numbered-score" aria-label={"简谱，1 等于 " + tonic + "，" + signature.value + "拍"}>
      {notes.map((note, index) => {
        const startsMeasure = note.measureIndex ? note.measureIndex !== lastMeasure : index === 0;
        lastMeasure = note.measureIndex || lastMeasure;
        const nextNote = notes[index + 1];
        const endsMeasure = !nextNote || (note.measureIndex && nextNote.measureIndex !== note.measureIndex);
        const rest = index > 0 && note.hasBreathBefore ? restByNextPhrase.get(note.phraseId) : null;
        const jianpu = getJianpuNote(note.midi, tonic);
        const upperDots = Math.max(0, jianpu.octaveOffset);
        const lowerDots = Math.max(0, -jianpu.octaveOffset);
        return (
          <div className={"numbered-note" + (startsMeasure ? " first-in-measure" : "") + (endsMeasure ? " last-in-measure" : "")} key={(note.id || note.midi) + "-" + index}>
            {rest ? <span className="numbered-rest" title="气口休止">休</span> : null}
            <button
              className={(selectedNote === index ? "selected" : "") + (playingIndex === index ? " playing" : "")}
              onClick={() => onSelect(index)}
              aria-label={"第 " + (index + 1) + " 个音，" + jianpu.label + "，" + note.duration + "音符，点击修正"}
            >
              <span className="jianpu-octave-dots upper" aria-hidden="true">{Array.from({ length: upperDots }).map((_, dotIndex) => <i key={dotIndex} />)}</span>
              <span className="jianpu-symbol"><em>{jianpu.accidental}</em><strong>{jianpu.degree}</strong></span>
              <span className="numbered-duration">{numberedDurationMark(note.durationBeats ?? note.beats)}</span>
              <span className="jianpu-octave-dots lower" aria-hidden="true">{Array.from({ length: lowerDots }).map((_, dotIndex) => <i key={dotIndex} />)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function AppIcon({ name, size = 20, strokeWidth = 1.9 }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true
  };

  const musicNote = <><ellipse cx="10.3" cy="16.1" rx="3.2" ry="2.25" transform="rotate(-18 10.3 16.1)" fill="currentColor" stroke="none" /><path d="M13.3 15.2V4.6c2.7.1 4.3 1.5 4.8 3.9" /></>;
  const paths = {
    logo: musicNote,
    microphone: <><rect x="8.2" y="3" width="7.6" height="12" rx="3.8" /><path d="M5.5 11.2a6.5 6.5 0 0 0 13 0M12 17.7v3.2M8.8 20.9h6.4" /></>,
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
    pause: <><path d="M8.5 6.5v11M15.5 6.5v11" /></>,
    play: <path d="m9 6.6 8.7 5.4L9 17.4z" fill="currentColor" stroke="none" />,
    upload: <><path d="M12 15V4.5M8 8.5l4-4 4 4M5 15.5v3.3a1.7 1.7 0 0 0 1.7 1.7h10.6a1.7 1.7 0 0 0 1.7-1.7v-3.3" /></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.8" fill="var(--app-paper)" /><circle cx="15" cy="12" r="1.8" fill="var(--app-paper)" /><circle cx="11" cy="18" r="1.8" fill="var(--app-paper)" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    recording: <><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /></>,
    score: musicNote,
    sparkle: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" /><path d="m18.5 16 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.8-3.9L3.5 9M4 5v4h4" /><path d="M4 13a8 8 0 0 0 14.8 3.9l1.7-1.9M20 19v-4h-4" /></>,
    check: <path d="m5 12.5 4.2 4.2L19 7" />
  };

  return <svg {...shared}>{paths[name] || paths.logo}</svg>;
}

function ReactiveVinyl({ audioRef, listening, paused, beat, children }) {
  const canvasRef = useRef(null);
  const energyRef = useRef(0);
  const bandsRef = useRef(new Float32Array(96));

  useEffect(() => {
    const canvas = canvasRef.current;
    const canvasContext = canvas?.getContext("2d");
    if (!canvas || !canvasContext) return undefined;

    const segmentCount = 96;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animationFrame = null;
    let timeData = null;
    let frequencyData = null;

    function resizeCanvas() {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      return bounds;
    }

    function draw() {
      const bounds = resizeCanvas();
      const width = bounds.width;
      const height = bounds.height;
      if (width < 28 || height < 28) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const outerRadius = Math.min(width, height) / 2 - 12;
      const analyser = audioRef.current.analyserNode;
      let targetEnergy = 0;

      if (listening && !paused && analyser) {
        if (!timeData || timeData.length !== analyser.fftSize) {
          timeData = new Uint8Array(analyser.fftSize);
        }
        if (!frequencyData || frequencyData.length !== analyser.frequencyBinCount) {
          frequencyData = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(frequencyData);

        let energy = 0;
        for (const sampleByte of timeData) {
          const sample = (sampleByte - 128) / 128;
          energy += sample * sample;
        }
        const rms = Math.sqrt(energy / timeData.length);
        // Human humming is often much quieter than speech, so normalize its usable range.
        targetEnergy = clamp((rms - 0.003) / 0.028, 0, 1);
      }

      // Smooth the microphone signal before drawing so humming feels fluid, not jittery.
      const energySmoothing = targetEnergy > energyRef.current ? 0.22 : 0.075;
      energyRef.current += (targetEnergy - energyRef.current) * energySmoothing;
      const visualEnergy = energyRef.current;
      const bands = bandsRef.current;

      for (let index = 0; index < segmentCount; index += 1) {
        const frequencyIndex = frequencyData
          ? Math.min(frequencyData.length - 1, Math.floor((index / segmentCount) ** 1.7 * (frequencyData.length - 1)))
          : 0;
        const frequencyLevel = frequencyData ? frequencyData[frequencyIndex] / 255 : 0;
        const timeIndex = timeData ? Math.floor((index / segmentCount) * timeData.length) : 0;
        const timeLevel = timeData ? Math.abs((timeData[timeIndex] - 128) / 128) : 0;
        const targetBand = clamp(Math.max(frequencyLevel, timeLevel * 1.35) * 2.3 - 0.035, 0, 1);
        bands[index] += (targetBand - bands[index]) * 0.18;
      }

      canvasContext.clearRect(0, 0, width, height);
      const ringColors = ["109, 88, 220", "255, 255, 255", "47, 190, 160"];

      for (let ring = 0; ring < 8; ring += 1) {
        const baseRadius = outerRadius * (0.3 + ring * 0.071);
        canvasContext.beginPath();

        for (let index = 0; index <= segmentCount; index += 1) {
          const wrappedIndex = index % segmentCount;
          const band = bands[(wrappedIndex + ring * 11) % segmentCount];
          const rawMovement = band * (10 + visualEnergy * 40) + visualEnergy * (1 + ring * 0.35);
          const maxMovement = Math.max(3, outerRadius - baseRadius - 5);
          const radius = baseRadius + Math.min(rawMovement, maxMovement);
          const angle = (wrappedIndex / segmentCount) * Math.PI * 2 - Math.PI / 2;
          const x = centerX + Math.cos(angle) * radius;
          const y = centerY + Math.sin(angle) * radius;
          if (index === 0) canvasContext.moveTo(x, y);
          else canvasContext.lineTo(x, y);
        }

        const alpha = 0.15 + ring * 0.016 + visualEnergy * 0.24;
        canvasContext.strokeStyle = `rgba(${ringColors[ring % ringColors.length]}, ${alpha})`;
        canvasContext.lineWidth = ring % 3 === 0 ? 1.35 : 0.8;
        canvasContext.stroke();
      }

      if (visualEnergy > 0.015) {
        canvasContext.beginPath();
        canvasContext.arc(centerX, centerY, outerRadius * 0.87, 0, Math.PI * 2);
        canvasContext.strokeStyle = `rgba(255, 229, 146, ${0.08 + visualEnergy * 0.3})`;
        canvasContext.lineWidth = 1.5 + visualEnergy * 2;
        canvasContext.stroke();
      }
    }

    function renderFrame() {
      draw();
      if (listening && !paused && !document.hidden && !reducedMotion?.matches) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    }

    function restartDrawing() {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      draw();
      if (listening && !paused && !document.hidden && !reducedMotion?.matches) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    }

    const handleVisibilityChange = () => restartDrawing();
    const handleMotionChange = () => restartDrawing();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restartDrawing);
    resizeObserver?.observe(canvas);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (reducedMotion?.addEventListener) reducedMotion.addEventListener("change", handleMotionChange);
    else reducedMotion?.addListener?.(handleMotionChange);
    restartDrawing();

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (reducedMotion?.removeEventListener) reducedMotion.removeEventListener("change", handleMotionChange);
      else reducedMotion?.removeListener?.(handleMotionChange);
    };
  }, [audioRef, listening, paused]);

  return (
    <div className={`reactive-vinyl${listening ? " is-listening" : ""}${paused ? " is-paused" : ""}${beat ? " is-on-beat" : ""}${beat?.isDownbeat ? " is-downbeat" : ""}`}>
      <div className="vinyl-colour-field" aria-hidden="true" />
      {beat ? <span className={`vinyl-beat-pulse${beat.isDownbeat ? " downbeat" : ""}`} key={`${beat.beatIndex}-${beat.scheduledBeatTime}`} aria-hidden="true" /> : null}
      <canvas ref={canvasRef} className="vinyl-wave-canvas" aria-hidden="true" />
      <div className="vinyl-center">{children}</div>
    </div>
  );
}

function ProductApp() {
  const [melody, setMelody] = useState({
    title: "未命名旋律",
    analysis: "录好一段旋律后，识别结果会显示在这里。",
    beatUnitSeconds: 0.55,
    confidence: 0,
    tempo: 0,
    notes: []
  });
  const [activeTab, setActiveTab] = useState("capture");
  const [currentView, setCurrentView] = useState("numbered");
  const [instrument, setInstrument] = useState("Piano");
  const [instrumentLoadState, setInstrumentLoadState] = useState({ state: "idle", instrumentId: "", loaded: 0, total: 0, cached: false, error: "" });
  const [playbackStyle, setPlaybackStyle] = useState("legato");
  const [recordingState, setRecordingState] = useState("idle");
  const [recordDuration, setRecordDuration] = useState(0);
  const [livePitch, setLivePitch] = useState("--");
  const [captureOutcome, setCaptureOutcome] = useState("waiting");
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [metronomeSettings, setMetronomeSettings] = useState(() => ({ ...DEFAULT_METRONOME_SETTINGS, cueMode: { ...DEFAULT_METRONOME_SETTINGS.cueMode } }));
  const [metronomeBeat, setMetronomeBeat] = useState(null);
  const [rhythmData, setRhythmData] = useState(null);
  const [rhythmPreviewMode, setRhythmPreviewMode] = useState("original");
  const [showRhythmPreview, setShowRhythmPreview] = useState(false);
  const [rhythmPreviewPlaying, setRhythmPreviewPlaying] = useState("");
  const [sourceInfo, setSourceInfo] = useState({ name: "", kind: "", duration: 0 });
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const [tunedPreviewUrl, setTunedPreviewUrl] = useState("");
  const [tuningEnabled, setTuningEnabled] = useState(false);
  const [tuningStrength, setTuningStrength] = useState("natural");
  const [tuningStatus, setTuningStatus] = useState("idle");
  const [tuningError, setTuningError] = useState("");
  const [tuningDiagnostics, setTuningDiagnostics] = useState(null);
  const [transcriptionSource, setTranscriptionSource] = useState("original");
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("先开始哼唱，或导入一段已有录音。");
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [selectedNote, setSelectedNote] = useState(null);
  const [editorSnapshot, setEditorSnapshot] = useState(null);
  const [editorNotesSnapshot, setEditorNotesSnapshot] = useState(null);
  const [lastEdit, setLastEdit] = useState(null);
  const [playingIndex, setPlayingIndex] = useState(-1);
  const [playbackState, setPlaybackState] = useState("idle");
  const [resumeIndex, setResumeIndex] = useState(0);
  const [autoTuneEnabled, setAutoTuneEnabled] = useState(true);
  const [autoTuneScale, setAutoTuneScale] = useState(null);
  const [manualPitchInput, setManualPitchInput] = useState("");
  const [transcriptionMode, setTranscriptionMode] = useState("melody");
  const [interpreterMode, setInterpreterMode] = useState("standard");
  const [tonic, setTonic] = useState(DEFAULT_TONIC);
  const [recognitionDiagnostics, setRecognitionDiagnostics] = useState(null);
  const [projects, setProjects] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [projectRevision, setProjectRevision] = useState(0);

  const audioRef = useRef(initialAudioState());
  const recognitionBaselineRef = useRef([]);
  const recognitionDiagnosticsRef = useRef(null);
  const projectsRef = useRef([]);
  const currentProjectIdRef = useRef(null);
  const projectStatusRef = useRef("pending");
  const hasRestoredProjectRef = useRef(false);
  const recordingStateRef = useRef("idle");
  const toastTimerRef = useRef(null);
  const pendingTranscribeRef = useRef(false);
  const tuningAbortRef = useRef(null);
  // Each playback run owns its timers, so an older melody can never stop a newer one.
  const playbackRunRef = useRef(0);
  const importInputRef = useRef(null);
  const sheetTouchStartRef = useRef(null);
  const lastPitchUpdateRef = useRef(0);
  const livePitchRef = useRef("--");

  const notes = melody.notes || [];
  const selectedNoteData = selectedNote === null ? null : notes[selectedNote];
  const activeRhythm = rhythmData || DEFAULT_RHYTHM_SETTINGS;
  // Display annotations never rewrite the real timestamps stored in melody.notes.
  const scoreAnnotation = notes.length ? annotateOriginalRhythmNotes(notes, activeRhythm) : { notes: [], rests: [] };
  const scoreNotes = scoreAnnotation.notes;
  const scoreRests = scoreAnnotation.rests;
  const diagnosticsEnabled = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("diagnostics");

  function normalizePhraseMetadata(sourceNotes) {
    const nextNotes = deepClone(sourceNotes || []);
    let phraseNumber = 0;
    let currentPhrase = null;
    nextNotes.forEach((note, index) => {
      const previous = nextNotes[index - 1];
      const startsPhrase = !previous || Boolean(note.hasBreathBefore) || note.phraseId !== previous.phraseId;
      if (startsPhrase) {
        phraseNumber += 1;
        currentPhrase = `phrase-${phraseNumber}`;
      }
      note.phraseId = note.phraseId || currentPhrase;
      if (note.phraseId !== currentPhrase) currentPhrase = note.phraseId;
      note.hasBreathBefore = startsPhrase && index > 0;
      note.hasBreathAfter = Boolean(note.hasBreathAfter);
    });
    nextNotes.forEach((note, index) => {
      const phraseNotes = nextNotes.filter((candidate) => candidate.phraseId === note.phraseId);
      note.phraseStart = phraseNotes[0]?.startTime ?? note.startTime ?? 0;
      note.phraseEnd = phraseNotes[phraseNotes.length - 1]?.endTime ?? note.endTime ?? note.phraseStart;
      if (index < nextNotes.length - 1 && nextNotes[index + 1].phraseId !== note.phraseId) note.hasBreathAfter = true;
      if (index > 0 && nextNotes[index - 1].phraseId !== note.phraseId) note.hasBreathBefore = true;
    });
    return nextNotes;
  }

  function normalizeRhythmSource(rhythm) {
    if (!rhythm) return null;
    const quantizedApplied = rhythm.rhythmSource === "quantized" && Boolean(rhythm.quantizationEnabled) && Boolean(rhythm.quantizedNotes?.length);
    return {
      ...rhythm,
      rhythmSource: quantizedApplied ? "quantized" : "original",
      quantizationEnabled: quantizedApplied,
      quantizationPreviewStatus: rhythm.quantizationPreviewStatus || (rhythm.quantizedNotes?.length ? "ready" : "idle")
    };
  }

  function syncNotePitch(note, midi, extra = {}) {
    return {
      ...note,
      ...createNote(midi, note.beats, melody.beatUnitSeconds || 0.55, note.noteSeconds, {
        frequency: Number.isFinite(extra.frequency) ? extra.frequency : midiToFreq(midi),
        startTime: note.startTime,
        endTime: note.endTime
      }),
      ...extra
    };
  }

  function updateRecognitionDiagnostics(nextDiagnostics) {
    const snapshot = nextDiagnostics ? deepClone(nextDiagnostics) : null;
    recognitionDiagnosticsRef.current = snapshot;
    setRecognitionDiagnostics(snapshot);
  }

  function tuneNote(note, enabled, profile = autoTuneScale) {
    const originalMidi = note.originalMidi ?? note.midi;
    const tunedMidi = enabled && profile ? snapMidiToScale(originalMidi, profile.pitchClasses) : originalMidi;
    return syncNotePitch(note, tunedMidi, { originalMidi, autoTune: enabled });
  }

  function showToast(message) {
    setToastMessage(message);
    setToastVisible(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 2200);
  }

  async function copyRecognitionTestResult() {
    if (!recognitionDiagnostics) {
      showToast("这段作品还没有可复制的识别结果");
      return;
    }
    const rhythmModel = currentRhythmModel();
    const summarizeTiming = (sourceNotes = []) => sourceNotes.map((note, index) => ({
      index,
      id: note.id || null,
      midi: note.midi ?? null,
      startTime: note.startTime ?? note.startTimeSeconds ?? null,
      endTime: note.endTime ?? note.endTimeSeconds ?? null,
      duration: note.noteSeconds ?? note.durationSeconds ?? note.duration ?? null,
      startBeat: note.startBeat ?? null,
      durationBeats: note.durationBeats ?? note.beats ?? null,
      phraseId: note.phraseId ?? null,
      restBefore: note.restBefore ?? null,
      manualEdit: note.manualEdit ?? null
    }));
    const report = {
      projectId: currentProjectIdRef.current,
      title: melody.title,
      generatedAt: new Date().toISOString(),
      source: sourceInfo.kind || "unknown",
      durationSeconds: sourceInfo.duration || recordDuration,
      transcriptionSource,
      interpreterMode,
      interpreterVersion: recognitionDiagnostics.interpreterVersion || HUMMING_INTERPRETER_VERSION,
      tuning: { enabled: tuningEnabled, status: tuningStatus, strength: tuningStrength, diagnostics: tuningDiagnostics },
      recognitionDiagnostics,
      articulationTrace: {
        audioAnalysis: recognitionDiagnostics.audioAnalysis || null,
        rawCandidatePeaks: recognitionDiagnostics.audioAnalysis?.rawCandidates || [],
        clusteredArticulationEvents: recognitionDiagnostics.audioAnalysis?.articulationEvents || [],
        rawBasicPitchEvents: recognitionDiagnostics.rawBasicPitchEvents || [],
        framePitchTrack: recognitionDiagnostics.framePitchTrack || [],
        stableFramePitchRegions: recognitionDiagnostics.stableFramePitchRegions || [],
        pitchStabilizationDecisions: recognitionDiagnostics.pitchStabilizationDecisions || [],
        pitchStabilizedNotes: recognitionDiagnostics.pitchStabilizedNotes || [],
        articulationEvents: recognitionDiagnostics.articulationEvents || [],
        preArticulationInterpretedNotes: recognitionDiagnostics.preArticulationInterpretedNotes || [],
        postArticulationNotes: recognitionDiagnostics.postArticulationNotes || [],
        boundaryDecisions: recognitionDiagnostics.boundaryDecisions || [],
        fastPitchRecoveryApplied: Boolean(recognitionDiagnostics.fastPitchRecoveryApplied),
        manualEdits: notes.filter((note) => note.manualEdit).map((note) => ({ id: note.id, manualEdit: note.manualEdit }))
      },
      rhythmTrace: {
        rawBasicPitchNotes: summarizeTiming(recognitionDiagnostics.rawBasicPitchEvents || []),
        interpretedNotes: summarizeTiming(recognitionDiagnostics.interpretedNotes || recognitionBaselineRef.current),
        originalRhythmNotes: summarizeTiming(rhythmModel.originalRhythmNotes || []),
        quantizedNotes: summarizeTiming(rhythmModel.quantizedNotes || []),
        editedNotes: summarizeTiming(notes),
        numberedScoreNotes: summarizeTiming(scoreNotes),
        staffScoreNotes: summarizeTiming(scoreNotes),
        playerNotes: summarizeTiming(notes),
        currentFormalSource: rhythmModel.rhythmSource === "quantized" ? "editedNotes (explicitly applied quantized timing)" : "editedNotes (original timing)",
        rhythmSource: rhythmModel.rhythmSource,
        quantizationEnabled: Boolean(rhythmModel.quantizationEnabled),
        selectedBpm: rhythmModel.selectedBpm || null,
        bpmSource: rhythmModel.bpmSource || null,
        timeSignature: rhythmModel.selectedTimeSignature || null,
        quantizationDiagnostics: rhythmModel.quantizationDiagnostics || null
      },
      rawBasicPitchNotes: recognitionDiagnostics.rawBasicPitchEvents || [],
      interpretedNotes: recognitionDiagnostics.interpretedNotes || recognitionBaselineRef.current,
      processedDetectedNotes: recognitionBaselineRef.current,
      editedNotes: notes
    };
    const text = JSON.stringify(report, null, 2);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      showToast("测试结果已复制");
    } catch (error) {
      setStatusMessage("浏览器没有允许复制测试结果，请在普通浏览器标签页中重试。 ");
    }
  }

  function updateProjectsList(project) {
    const next = [...projectsRef.current.filter((item) => item.id !== project.id), project]
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
    projectsRef.current = next;
    setProjects(next);
  }

  function rememberCurrentProject(id, status = projectStatusRef.current) {
    currentProjectIdRef.current = id;
    projectStatusRef.current = status;
    setCurrentProjectId(id);
    if (id) window.localStorage.setItem(LAST_PROJECT_KEY, id);
    else window.localStorage.removeItem(LAST_PROJECT_KEY);
  }

  function buildProjectSnapshot(overrides = {}) {
    const audioState = audioRef.current;
    const id = overrides.id || currentProjectIdRef.current;
    const existing = projectsRef.current.find((project) => project.id === id);
    const now = new Date().toISOString();
    const source = overrides.sourceInfo || sourceInfo;
    const melodyData = overrides.melodyData || melody;
    const fallbackName = existing?.name || nextUntitledProjectName(projectsRef.current);
    const name = normalizeProjectName(overrides.name ?? melodyData.title, fallbackName);
    const selectedTranscriptionSource = overrides.transcriptionSource || transcriptionSource;
    const existingTranscript = existing?.transcriptions?.[selectedTranscriptionSource] || {};
    // A generated quantization preview is saved as a preview, never as the formal rhythm source.
    const rhythmSnapshot = deepClone(normalizeRhythmSource(overrides.rhythm ?? currentRhythmModel() ?? existingTranscript.rhythm ?? existing?.rhythm ?? null));
    const metronomeSnapshot = deepClone(overrides.metronome ?? existing?.metronome ?? audioState.metronomeTiming ?? null);
    const processedDetectedNotes = normalizePhraseMetadata(
      overrides.processedDetectedNotes
      ?? existingTranscript.processedDetectedNotes
      ?? existing?.processedDetectedNotes
      ?? overrides.originalDetectedNotes
      ?? recognitionBaselineRef.current
      ?? []
    );
    const originalDetectedNotes = deepClone(overrides.originalDetectedNotes ?? processedDetectedNotes);
    const rawBasicPitchNotes = deepClone(
      overrides.rawBasicPitchNotes ?? existingTranscript.rawBasicPitchNotes ?? existing?.rawBasicPitchNotes ?? []
    );
    const editedNotes = normalizePhraseMetadata(overrides.editedNotes ?? melodyData.notes ?? []);
    const recognitionDiagnosticsSnapshot = deepClone(
      overrides.recognitionDiagnostics ?? recognitionDiagnosticsRef.current ?? existingTranscript.recognitionDiagnostics ?? existing?.recognitionDiagnostics ?? null
    );
    const audioAnalysisSnapshot = deepClone(
      overrides.audioAnalysis ?? recognitionDiagnosticsSnapshot?.audioAnalysis ?? existingTranscript.audioAnalysis ?? existing?.audioAnalysis ?? null
    );
    const transcript = {
      rawBasicPitchNotes,
      processedDetectedNotes,
      interpretedNotes: deepClone(overrides.interpretedNotes ?? processedDetectedNotes),
      editedNotes,
      recognitionDiagnostics: recognitionDiagnosticsSnapshot,
      audioAnalysis: audioAnalysisSnapshot,
      recognitionEngine: overrides.recognitionEngine || recognitionDiagnosticsSnapshot?.recognitionEngine || existingTranscript.recognitionEngine || null,
      recognitionVersion: overrides.recognitionVersion || recognitionDiagnosticsSnapshot?.recognitionVersion || existingTranscript.recognitionVersion || RECOGNITION_VERSION,
      interpreterMode: overrides.interpreterMode || recognitionDiagnosticsSnapshot?.interpreterMode || existingTranscript.interpreterMode || interpreterMode,
      interpreterVersion: overrides.interpreterVersion || recognitionDiagnosticsSnapshot?.interpreterVersion || existingTranscript.interpreterVersion || HUMMING_INTERPRETER_VERSION,
      melody: {
        analysis: melodyData.analysis || "录好一段旋律后，识别结果会显示在这里。",
        beatUnitSeconds: melodyData.beatUnitSeconds || 0.55,
        confidence: melodyData.confidence || 0,
        tempo: melodyData.tempo || 0
      },
      originalRhythmNotes: deepClone(overrides.originalRhythmNotes ?? rhythmSnapshot?.originalRhythmNotes ?? existingTranscript.originalRhythmNotes ?? processedDetectedNotes),
      quantizedNotes: deepClone(overrides.quantizedNotes ?? rhythmSnapshot?.quantizedNotes ?? existingTranscript.quantizedNotes ?? []),
      rhythm: rhythmSnapshot,
      updatedAt: now
    };
    const transcriptions = { ...(existing?.transcriptions || {}) };
    if (overrides.storeTranscript !== false && (rawBasicPitchNotes.length || processedDetectedNotes.length || editedNotes.length)) {
      transcriptions[selectedTranscriptionSource] = transcript;
    }
    const originalAudioBlob = overrides.originalAudioBlob || audioState.recordedBlob || existing?.originalAudioBlob || existing?.audioBlob || null;
    const tunedAudioBlob = Object.prototype.hasOwnProperty.call(overrides, "tunedAudioBlob")
      ? overrides.tunedAudioBlob
      : audioState.tunedBlob ?? existing?.tunedAudioBlob ?? null;

    return {
      ...existing,
      id,
      name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      sourceType: overrides.sourceType || source.kind || existing?.sourceType || "recording",
      sourceName: overrides.sourceName || source.name || existing?.sourceName || "",
      // Retain audioBlob so schema v1/v2 clients can still read original recordings.
      audioBlob: originalAudioBlob,
      originalAudioBlob,
      tunedAudioBlob,
      duration: overrides.duration ?? source.duration ?? recordDuration ?? existing?.duration ?? 0,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      recognitionStatus: overrides.recognitionStatus || projectStatusRef.current || "pending",
      recognitionVersion: overrides.recognitionVersion || existing?.recognitionVersion || RECOGNITION_VERSION,
      rawBasicPitchNotes,
      processedDetectedNotes,
      interpretedNotes: transcript.interpretedNotes,
      originalDetectedNotes,
      editedNotes,
      recognitionDiagnostics: recognitionDiagnosticsSnapshot,
      audioAnalysis: audioAnalysisSnapshot,
      recognitionEngine: transcript.recognitionEngine,
      interpreterMode: transcript.interpreterMode,
      interpreterVersion: transcript.interpreterVersion,
      transcriptionSource: selectedTranscriptionSource,
      transcriptions,
      metronome: metronomeSnapshot,
      metronomeEnabled: Boolean(metronomeSnapshot?.enabled),
      metronomeBpm: metronomeSnapshot?.metronomeBpm || null,
      metronomeTimeSignature: metronomeSnapshot?.metronomeTimeSignature || null,
      metronomeCueMode: metronomeSnapshot?.metronomeCueMode || null,
      metronomeVolume: metronomeSnapshot?.metronomeVolume ?? null,
      countInMeasures: metronomeSnapshot?.countInMeasures ?? 0,
      countInStartedAt: metronomeSnapshot?.countInStartedAt ?? null,
      recordingStartedAt: metronomeSnapshot?.recordingStartedAt ?? null,
      firstBeatOffset: metronomeSnapshot?.firstBeatOffset ?? null,
      audioStartedAt: metronomeSnapshot?.audioStartedAt ?? null,
      detectedBpm: rhythmSnapshot?.detectedBpm ?? null,
      bpmConfidence: rhythmSnapshot?.bpmConfidence ?? null,
      bpmCandidates: rhythmSnapshot?.bpmCandidates ?? [],
      selectedBpm: rhythmSnapshot?.selectedBpm ?? null,
      bpmSource: rhythmSnapshot?.bpmSource ?? null,
      detectedTimeSignature: rhythmSnapshot?.detectedTimeSignature ?? null,
      selectedTimeSignature: rhythmSnapshot?.selectedTimeSignature ?? null,
      quantizationEnabled: Boolean(rhythmSnapshot?.quantizationEnabled),
      quantizationMode: rhythmSnapshot?.quantizationMode || "original",
      quantizationGrid: rhythmSnapshot?.quantizationGrid || "eighth",
      quantizationVersion: rhythmSnapshot?.quantizationVersion || null,
      rhythmSource: rhythmSnapshot?.rhythmSource || "original",
      lastRhythmAction: rhythmSnapshot?.lastRhythmAction || null,
      previousRhythmVersion: rhythmSnapshot?.previousRhythmVersion || null,
      rhythmUpdatedAt: rhythmSnapshot?.rhythmUpdatedAt || null,
      tuningEnabled: overrides.tuningEnabled ?? tuningEnabled,
      tuningMode: overrides.tuningMode || existing?.tuningMode || "free-chromatic",
      tuningStrength: overrides.tuningStrength || tuningStrength,
      tuningVersion: overrides.tuningVersion || existing?.tuningVersion || (tunedAudioBlob ? VOCAL_TUNING_VERSION : null),
      tuningStatus: overrides.tuningStatus || tuningStatus,
      tuningCreatedAt: overrides.tuningCreatedAt ?? existing?.tuningCreatedAt ?? null,
      tuningDiagnostics: deepClone(overrides.tuningDiagnostics ?? tuningDiagnostics ?? existing?.tuningDiagnostics ?? null),
      melody: {
        analysis: melodyData.analysis || "录好一段旋律后，识别结果会显示在这里。",
        beatUnitSeconds: melodyData.beatUnitSeconds || 0.55,
        confidence: melodyData.confidence || 0,
        tempo: melodyData.tempo || 0
      },
      selectedInstrument: overrides.selectedInstrument || instrument,
      autoTuneEnabled: overrides.autoTuneEnabled ?? autoTuneEnabled,
      autoTuneScale: overrides.autoTuneScale ?? autoTuneScale,
      transcriptionMode: overrides.transcriptionMode || transcriptionMode,
      tonic: overrides.tonic || tonic || DEFAULT_TONIC
    };
  }

  async function persistCurrentProject(overrides = {}) {
    const id = overrides.id || currentProjectIdRef.current;
    if (!id || !audioRef.current.recordedBlob) return null;
    const project = buildProjectSnapshot({ ...overrides, id });
    if (!project.audioBlob) return null;
    await saveProject(project);
    rememberCurrentProject(project.id, project.recognitionStatus);
    updateProjectsList(project);
    return project;
  }

  async function createProjectForAudio({ blob, name, kind, duration, frames = [], metronome = null }) {
    // IndexedDB is the source of truth for numbering when a page has just been restored.
    const storedProjects = await listProjects();
    projectsRef.current = storedProjects;
    setProjects(storedProjects);
    const now = new Date().toISOString();
    const projectName = nextUntitledProjectName(storedProjects);
    const project = {
      id: createProjectId(),
      name: projectName,
      createdAt: now,
      updatedAt: now,
      sourceType: kind,
      sourceName: name,
      audioBlob: blob,
      originalAudioBlob: blob,
      tunedAudioBlob: null,
      duration: duration || 0,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      recognitionStatus: "pending",
      recognitionVersion: RECOGNITION_VERSION,
      rawBasicPitchNotes: [],
      processedDetectedNotes: [],
      interpretedNotes: [],
      originalDetectedNotes: [],
      editedNotes: [],
      recognitionDiagnostics: null,
      audioAnalysis: null,
      transcriptions: {},
      transcriptionSource: "original",
      metronome: deepClone(metronome),
      rhythm: null,
      tuningEnabled: false,
      tuningMode: "free-chromatic",
      tuningStrength: "natural",
      tuningVersion: null,
      tuningStatus: "idle",
      tuningCreatedAt: null,
      tuningDiagnostics: null,
      interpreterMode: "standard",
      melody: {
        analysis: "录音已保存，确认后开始识别旋律。",
        beatUnitSeconds: 0.55,
        confidence: 0,
        tempo: 0
      },
      selectedInstrument: instrument,
      autoTuneEnabled,
      autoTuneScale: null,
      transcriptionMode,
      tonic: DEFAULT_TONIC
    };
    recognitionBaselineRef.current = [];
    updateRecognitionDiagnostics(null);
    rememberCurrentProject(project.id, "pending");
    updateProjectsList(project);
    setMelody({ title: projectName, notes: [], ...project.melody });
    setAutoTuneScale(null);
    setRhythmData(null);
    setRhythmPreviewMode("original");
    setTuningEnabled(false);
    setTuningStrength("natural");
    setTuningStatus("idle");
    setTuningError("");
    setTuningDiagnostics(null);
    setTranscriptionSource("original");
    setSelectedNote(null);
    await saveProject(project);
    return project;
  }

  async function restoreProject(project) {
    if (!project?.originalAudioBlob && !project?.audioBlob) {
      setStatusMessage("这个作品缺少本地音频，无法恢复。请保留浏览器数据后再试。 ");
      return;
    }
    stopInstrumentPlayback();
    replaceAudioSource(project.originalAudioBlob || project.audioBlob, {
      name: project.sourceName || project.name,
      kind: project.sourceType || "recording",
      duration: project.duration || 0
    });
    if (project.tunedAudioBlob) replaceTunedAudio(project.tunedAudioBlob);
    const restoredSource = project.transcriptionSource === "tuned" && project.tunedAudioBlob ? "tuned" : "original";
    const activeTranscript = project.transcriptions?.[restoredSource] || null;
    const processedNotes = normalizePhraseMetadata(
      activeTranscript?.processedDetectedNotes?.length
        ? activeTranscript.processedDetectedNotes
        : project.processedDetectedNotes?.length ? project.processedDetectedNotes : project.originalDetectedNotes || []
    );
    const editedNotes = normalizePhraseMetadata(
      activeTranscript?.editedNotes?.length
        ? activeTranscript.editedNotes
        : project.editedNotes?.length ? project.editedNotes : processedNotes
    );
    recognitionBaselineRef.current = deepClone(processedNotes);
    updateRecognitionDiagnostics(activeTranscript?.recognitionDiagnostics || project.recognitionDiagnostics || null);
    rememberCurrentProject(project.id, project.recognitionStatus || "pending");
    const restoredRhythm = normalizeRhythmSource(activeTranscript?.rhythm || project.rhythm || null);
    setMelody({
      title: project.name,
      analysis: activeTranscript?.melody?.analysis || project.melody?.analysis || "已从本地作品库恢复。",
      beatUnitSeconds: activeTranscript?.melody?.beatUnitSeconds || project.melody?.beatUnitSeconds || 0.55,
      confidence: activeTranscript?.melody?.confidence || project.melody?.confidence || 0,
      // Detecting BPM never recalculates timing while a saved work is reopened.
      tempo: activeTranscript?.melody?.tempo || project.melody?.tempo || restoredRhythm?.naturalTempo || 0,
      notes: editedNotes
    });
    setRhythmData(restoredRhythm);
    setRhythmPreviewMode(restoredRhythm?.rhythmSource === "quantized" ? "quantized" : "original");
    setShowRhythmPreview(false);
    const restoredMetronome = project.metronome || {
      enabled: Boolean(project.metronomeEnabled),
      bpm: project.metronomeBpm || DEFAULT_METRONOME_SETTINGS.bpm,
      timeSignature: project.metronomeTimeSignature || DEFAULT_METRONOME_SETTINGS.timeSignature,
      cueMode: project.metronomeCueMode || DEFAULT_METRONOME_SETTINGS.cueMode,
      volume: project.metronomeVolume ?? DEFAULT_METRONOME_SETTINGS.volume,
      countInMeasures: project.countInMeasures ?? DEFAULT_METRONOME_SETTINGS.countInMeasures
    };
    audioRef.current.metronomeTiming = restoredMetronome?.enabled ? deepClone(restoredMetronome) : null;
    setMetronomeSettings({
      ...DEFAULT_METRONOME_SETTINGS,
      ...restoredMetronome,
      speed: METRONOME_SPEEDS[restoredMetronome.speed] ? restoredMetronome.speed : "medium",
      bpm: METRONOME_SPEEDS[restoredMetronome.speed]?.bpm || DEFAULT_METRONOME_SETTINGS.bpm,
      timeSignature: "4/4",
      countInMeasures: 0,
      soundPreset: "warmWood",
      cueMode: { ...DEFAULT_METRONOME_SETTINGS.cueMode, ...(restoredMetronome.cueMode || {}), visual: true, vibrate: false }
    });
    setInstrument(project.selectedInstrument || "Piano");
    setAutoTuneEnabled(project.autoTuneEnabled !== false);
    setAutoTuneScale(project.autoTuneScale || (processedNotes.length ? inferAutoTuneScale(processedNotes) : null));
    setTranscriptionMode(project.transcriptionMode || "melody");
    setInterpreterMode(project.interpreterMode || "standard");
    setTuningEnabled(Boolean(project.tuningEnabled));
    setTuningStrength(project.tuningStrength || "natural");
    setTuningStatus(project.tuningStatus || (project.tunedAudioBlob ? "ready" : "idle"));
    setTuningError("");
    setTuningDiagnostics(project.tuningDiagnostics || null);
    setTranscriptionSource(restoredSource);
    setTonic(project.tonic || DEFAULT_TONIC);
    setSelectedNote(null);
    setCaptureOutcome(editedNotes.length ? "success" : "complete");
    setStatusMessage(editedNotes.length ? "已从本地作品库恢复曲谱和原始录音。" : "已恢复未识别的录音，可以继续试听或开始识别。 ");
    setActiveTab(editedNotes.length ? "score" : "capture");
  }

  async function openProject(projectId) {
    try {
      const project = await getProject(projectId);
      if (!project) {
        showToast("这个作品已不存在");
        return;
      }
      await restoreProject(project);
    } catch (error) {
      setStatusMessage("打开作品失败。请检查浏览器是否允许本地存储。 ");
    }
  }

  async function deleteProject(project) {
    if (!window.confirm(`确定删除“${project.name}”吗？原始录音和曲谱都会从当前设备移除。`)) return;
    try {
      await removeProject(project.id);
      const next = projectsRef.current.filter((item) => item.id !== project.id);
      projectsRef.current = next;
      setProjects(next);
      if (currentProjectIdRef.current === project.id) {
        rememberCurrentProject(null, "pending");
        clearAudioSource();
        setMelody({
          title: "未命名旋律",
          analysis: "录好一段旋律后，识别结果会显示在这里。",
          beatUnitSeconds: 0.55,
          confidence: 0,
          tempo: 0,
          notes: []
        });
      }
      showToast(`已删除“${project.name}”`);
    } catch (error) {
      setStatusMessage("删除作品失败，请再试一次。 ");
    }
  }

  function updateProjectName(value) {
    setMelody((current) => ({ ...current, title: value.slice(0, 40) }));
  }

  function commitProjectName() {
    const fallbackName = projectsRef.current.find((project) => project.id === currentProjectIdRef.current)?.name
      || nextUntitledProjectName(projectsRef.current);
    const name = normalizeProjectName(melody.title, fallbackName);
    const melodyData = { ...melody, title: name };
    setMelody(melodyData);
    void persistCurrentProject({ name, melodyData });
  }

  function queueProjectSave(status = "edited") {
    if (!currentProjectIdRef.current) return;
    projectStatusRef.current = status;
    setProjectRevision((revision) => revision + 1);
  }

  function clearRecordTimer() {
    if (audioRef.current.recordTimer) {
      clearInterval(audioRef.current.recordTimer);
      audioRef.current.recordTimer = null;
    }
  }

  function updateRecordedDuration() {
    const audioState = audioRef.current;
    const activeSeconds = recordingStateRef.current === "recording"
      ? (performance.now() - audioState.recordStartedAt) / 1000
      : 0;
    setRecordDuration(audioState.recordElapsedBeforePause + activeSeconds);
  }

  function startRecordTimer() {
    clearRecordTimer();
    updateRecordedDuration();
    audioRef.current.recordTimer = setInterval(updateRecordedDuration, 100);
  }

  function stopMetronome() {
    const audioState = audioRef.current;
    if (audioState.metronomeScheduler) {
      audioState.metronomeScheduler.stop();
      audioState.metronomeDiagnostics = audioState.metronomeScheduler.getDiagnostics();
      audioState.metronomeTiming = audioState.metronomeTiming ? { ...audioState.metronomeTiming, diagnostics: deepClone(audioState.metronomeDiagnostics) } : null;
      audioState.metronomeScheduler = null;
    }
    setMetronomeBeat(null);
  }

  function cleanupRecorderGraph() {
    const audioState = audioRef.current;
    clearRecordTimer();
    stopMetronome();
    audioState.realtimePitchTracker?.reset?.();
    audioState.realtimePitchTracker = null;
    livePitchRef.current = "--";
    setLivePitch("--");
    if (audioState.processorNode) {
      audioState.processorNode.onaudioprocess = null;
      audioState.processorNode.disconnect();
      audioState.processorNode = null;
    }
    if (audioState.analyserNode) {
      audioState.analyserNode.disconnect();
      audioState.analyserNode = null;
    }
    if (audioState.mediaSource) {
      audioState.mediaSource.disconnect();
      audioState.mediaSource = null;
    }
    if (audioState.silenceGain) {
      audioState.silenceGain.disconnect();
      audioState.silenceGain = null;
    }
    if (audioState.mediaStream) {
      audioState.mediaStream.getTracks().forEach((track) => track.stop());
      audioState.mediaStream = null;
    }
  }

  async function ensureAudioContext() {
    const audioState = audioRef.current;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      throw new Error("当前浏览器不支持乐器试听。");
    }

    // iOS can close an AudioContext after an interruption, such as switching apps.
    if (!audioState.audioContext || audioState.audioContext.state === "closed") {
      destroyInstrumentOutput(audioState);
      audioState.audioContext = new Context({ latencyHint: "interactive" });
      audioState.instrumentOutputUnlocked = false;
    }

    let context = audioState.audioContext;
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch (error) {
        throw new Error("浏览器没有允许乐器声音播放。");
      }
    }

    // Safari may keep an interrupted context suspended after resume. Recreate it once
    // rather than scheduling a melody that looks active but cannot reach the speaker.
    if (context.state === "interrupted") {
      destroyInstrumentOutput(audioState);
      try {
        await context.close();
      } catch (error) {
        // Closing an interrupted context is best-effort before creating a clean output.
      }
      context = new Context({ latencyHint: "interactive" });
      audioState.audioContext = context;
      audioState.instrumentOutputUnlocked = false;
      try {
        await context.resume();
      } catch (error) {
        throw new Error("浏览器没有允许乐器声音播放。");
      }
    }

    if (context.state !== "running") {
      throw new Error("乐器声音被系统暂时中断，请再点一次播放。");
    }

    return context;
  }

  async function decodeDuration(blob) {
    const context = await ensureAudioContext();
    const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0));
    return decoded.duration;
  }

  function replaceAudioSource(blob, { name, kind, duration, frames = [] }) {
    const audioState = audioRef.current;
    clearTunedPreview();
    if (audioState.recordedUrl) URL.revokeObjectURL(audioState.recordedUrl);
    const url = URL.createObjectURL(blob);
    audioState.recordedBlob = blob;
    audioState.recordedUrl = url;
    audioState.sourceName = name;
    audioState.sourceKind = kind;
    audioState.sourceDuration = duration || 0;
    audioState.lastCapturedFrames = frames;
    setVoicePreviewUrl(url);
    setSourceInfo({ name, kind, duration: duration || 0 });
    setRecordDuration(duration || 0);
  }

  function replaceTunedAudio(blob) {
    const audioState = audioRef.current;
    if (audioState.tunedUrl) URL.revokeObjectURL(audioState.tunedUrl);
    const url = URL.createObjectURL(blob);
    audioState.tunedBlob = blob;
    audioState.tunedUrl = url;
    setTunedPreviewUrl(url);
  }

  function clearTunedPreview({ resetSettings = true } = {}) {
    const audioState = audioRef.current;
    tuningAbortRef.current?.abort();
    tuningAbortRef.current = null;
    if (audioState.tunedUrl) URL.revokeObjectURL(audioState.tunedUrl);
    audioState.tunedBlob = null;
    audioState.tunedUrl = "";
    setTunedPreviewUrl("");
    if (resetSettings) {
      setTuningEnabled(false);
      setTuningStatus("idle");
      setTuningError("");
      setTuningDiagnostics(null);
      setTranscriptionSource("original");
    }
  }

  function clearAudioSource() {
    const audioState = audioRef.current;
    clearTunedPreview();
    if (audioState.recordedUrl) URL.revokeObjectURL(audioState.recordedUrl);
    audioState.recordedBlob = null;
    audioState.recordedUrl = "";
    audioState.sourceName = "";
    audioState.sourceKind = "";
    audioState.sourceDuration = 0;
    audioState.lastCapturedFrames = [];
    audioState.metronomeTiming = null;
    audioState.metronomeDiagnostics = [];
    setVoicePreviewUrl("");
    setSourceInfo({ name: "", kind: "", duration: 0 });
    setRecordDuration(0);
    setCaptureOutcome("waiting");
  }

  function prepareForNewRecording() {
    // Deliberately reset only; microphone access starts from the primary button.
    clearAudioSource();
    rememberCurrentProject(null, "pending");
    recognitionBaselineRef.current = [];
    updateRecognitionDiagnostics(null);
    setTonic(DEFAULT_TONIC);
    setRhythmData(null);
    setRhythmPreviewMode("original");
    setMelody({
      title: "未命名旋律",
      analysis: "录好一段旋律后，识别结果会显示在这里。",
      beatUnitSeconds: 0.55,
      confidence: 0,
      tempo: 0,
      notes: []
    });
    pendingTranscribeRef.current = false;
    livePitchRef.current = "--";
    setLivePitch("--");
    setStatusMessage("准备好开始哼唱。点击“开始哼唱”后才会打开麦克风。");
  }

  function beginOfficialRecording(recorder) {
    const audioState = audioRef.current;
    if (audioState.mediaRecorder !== recorder || recordingStateRef.current === "idle") return;
    if (recorder.state === "inactive") recorder.start(160);
    audioState.recordElapsedBeforePause = 0;
    audioState.recordStartedAt = performance.now();
    audioState.metronomeTiming = {
      ...audioState.metronomeTiming,
      recordingStartedAt: audioState.audioContext?.currentTime || 0,
      recordingStartedWallClock: new Date().toISOString(),
      firstBeatOffset: 0
    };
    recordingStateRef.current = "recording";
    setRecordingState("recording");
    setCaptureOutcome("recording");
    setRecordDuration(0);
    startRecordTimer();
    setStatusMessage(audioState.metronomeScheduler ? "正在录音，节拍器会持续提示拍点。" : "正在录音，哼完后点“结束录音”。");
  }

  function scheduleMetronomeRecording(context, recorder, settings = metronomeSettings) {
    const audioState = audioRef.current;
    const signature = getTimeSignature(settings.timeSignature);
    const countInBeats = Math.max(0, Number(settings.countInMeasures) || 0) * signature.numerator;
    const audioStartedAt = context.currentTime;
    // A fresh recording and its first visual/audio cue share the Web Audio clock.
    const countInStartedAt = context.currentTime + (countInBeats ? 0.1 : 0.02);
    const secondsPerBeat = 60 / Math.max(40, Math.min(200, Number(settings.bpm) || 80)) * (4 / signature.denominator);
    const firstBeatAt = countInStartedAt + countInBeats * secondsPerBeat;
    audioState.metronomeTiming = {
      enabled: true,
      metronomeBpm: Number(settings.bpm) || 80,
      metronomeTimeSignature: signature.value,
      metronomeCueMode: { ...settings.cueMode },
      metronomeVolume: settings.volume,
      countInMeasures: Number(settings.countInMeasures) || 0,
      countInStartedAt,
      recordingStartedAt: null,
      firstBeatAt,
      audioStartedAt,
      firstBeatOffset: 0,
      countInStartedWallClock: new Date(Date.now() + Math.max(0, countInStartedAt - audioStartedAt) * 1000).toISOString()
    };
    const scheduler = new MetronomeScheduler(context, settings);
    audioState.metronomeScheduler = scheduler;
    scheduler.start({
      startTime: countInStartedAt,
      onBeat: (beat) => {
        if (settings.cueMode?.visual) setMetronomeBeat(beat);
        if (beat.beatIndex === countInBeats && recordingStateRef.current === "countin") {
          beginOfficialRecording(recorder);
        }
      }
    });
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatusMessage("这个浏览器不能使用麦克风。请使用 Safari 或 Chrome，并通过 https 打开页面。");
      return;
    }

    try {
      stopInstrumentPlayback();
      stopMetronome();
      const context = await ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 }
      });
      // Keep the previous take intact until microphone permission has been granted.
      if (voicePreviewUrl) clearAudioSource();
      const audioState = audioRef.current;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      const processor = context.createScriptProcessor(2048, 1, 1);
      const silenceGain = context.createGain();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      silenceGain.gain.value = 0;

      audioState.mediaStream = stream;
      audioState.mediaSource = source;
      audioState.analyserNode = analyser;
      audioState.processorNode = processor;
      audioState.silenceGain = silenceGain;
      audioState.pitchFrames = [];
      audioState.realtimePitchTracker = createRealtimePitchTracker(processor.bufferSize || 2048);
      audioState.recordedChunks = [];
      audioState.recordElapsedBeforePause = 0;
      audioState.recordStartedAt = 0;
      lastPitchUpdateRef.current = 0;
      livePitchRef.current = "--";
      setLivePitch("--");

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silenceGain);
      silenceGain.connect(context.destination);
      processor.onaudioprocess = (event) => {
        if (recordingStateRef.current !== "recording") return;
        const input = event.inputBuffer.getChannelData(0);
        const analysis = estimatePitchYin(new Float32Array(input), context.sampleRate);
        const realtimePitch = audioState.realtimePitchTracker?.detect(input, context.sampleRate);
        const time = audioState.recordElapsedBeforePause + (performance.now() - audioState.recordStartedAt) / 1000;
        audioState.pitchFrames.push({ time, frequency: analysis.frequency, clarity: analysis.clarity, rms: analysis.rms });
        const now = performance.now();
        if (now - lastPitchUpdateRef.current > 120) {
          lastPitchUpdateRef.current = now;
          const nextPitch = realtimePitch ? midiToPitchName(realtimePitch.midi) : "--";
          if (nextPitch !== livePitchRef.current) {
            livePitchRef.current = nextPitch;
            setLivePitch(nextPitch);
          }
        }
      };

      const recorder = new MediaRecorder(stream);
      audioState.mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioState.recordedChunks.push(event.data);
      };
      recorder.onstop = async () => {
        const metronomeSnapshot = deepClone(audioState.metronomeTiming);
        cleanupRecorderGraph();
        const measuredDuration = audioState.recordElapsedBeforePause;
        if (!audioState.recordedChunks.length) {
          setCaptureOutcome("failure");
          setStatusMessage("没有获得有效录音，请再试一次。");
          return;
        }
        const blob = new Blob(audioState.recordedChunks, { type: recorder.mimeType || "audio/webm" });
        let actualDuration = measuredDuration;
        try {
          actualDuration = await decodeDuration(blob);
        } catch {
          // Some browser recording codecs cannot provide metadata until they are played.
        }
        replaceAudioSource(blob, {
          name: "刚刚的哼唱",
          kind: "recording",
          duration: actualDuration,
          frames: [...audioState.pitchFrames]
        });
        try {
          await createProjectForAudio({
            blob,
            name: "刚刚的哼唱",
            kind: "recording",
            duration: actualDuration,
            frames: [...audioState.pitchFrames],
            metronome: metronomeSnapshot
          });
        } catch {
          setStatusMessage("录音已完成，但暂时无法保存到本地作品库。 ");
        }
        livePitchRef.current = "--";
        setLivePitch("--");
        setCaptureOutcome("complete");
        setStatusMessage("录音已保存。先听听原始哼唱，确认后再开始识别。");
        showToast("录音完成");
        if (pendingTranscribeRef.current) {
          pendingTranscribeRef.current = false;
          void transcribeCurrentAudio();
        }
      };

      if (metronomeSettings.enabled) {
        setRecordDuration(0);
        scheduleMetronomeRecording(context, recorder);
        if (metronomeSettings.countInMeasures > 0) {
          // Kept for older stored projects and future advanced use; new recordings never enable it by default.
          recordingStateRef.current = "countin";
          setRecordingState("countin");
          setCaptureOutcome("countin");
          setStatusMessage("圆盘正在提示开始时机。");
        } else {
          // The recorder, timer, and Web Audio scheduler begin from the same interaction.
          recordingStateRef.current = "recording";
          beginOfficialRecording(recorder);
          setStatusMessage("正在录音，圆盘会按选定速度提示节奏。");
        }
      } else {
        audioState.metronomeTiming = {
          enabled: false,
          countInStartedAt: null,
          recordingStartedAt: context.currentTime,
          firstBeatAt: null,
          audioStartedAt: context.currentTime,
          firstBeatOffset: null
        };
        recordingStateRef.current = "recording";
        beginOfficialRecording(recorder);
      }
    } catch (error) {
      cleanupRecorderGraph();
      recordingStateRef.current = "idle";
      setRecordingState("idle");
      setCaptureOutcome("failure");
      setStatusMessage(`麦克风没有打开：${error.message || "请检查权限"}`);
    }
  }

  function resumeMetronomeAfterPause(context) {
    const audioState = audioRef.current;
    if (!metronomeSettings.enabled) return;
    const scheduler = new MetronomeScheduler(context, metronomeSettings);
    audioState.metronomeScheduler = scheduler;
    scheduler.start({
      startTime: context.currentTime + 0.06,
      onBeat: (beat) => { if (metronomeSettings.cueMode?.visual) setMetronomeBeat(beat); }
    });
  }

  function pauseRecording() {
    const audioState = audioRef.current;
    if (recordingStateRef.current !== "recording") return;
    audioState.recordElapsedBeforePause += (performance.now() - audioState.recordStartedAt) / 1000;
    clearRecordTimer();
    stopMetronome();
    audioState.mediaRecorder?.pause();
    recordingStateRef.current = "paused";
    setRecordingState("paused");
    setCaptureOutcome("paused");
    setRecordDuration(audioState.recordElapsedBeforePause);
    setStatusMessage(metronomeSettings.enabled ? "录音与节拍器已暂停，可以继续哼唱或结束录音。" : "录音已暂停，可以继续哼唱或结束录音。");
  }

  function resumeRecording() {
    const audioState = audioRef.current;
    if (recordingStateRef.current !== "paused") return;
    audioState.recordStartedAt = performance.now();
    audioState.mediaRecorder?.resume();
    recordingStateRef.current = "recording";
    setRecordingState("recording");
    setCaptureOutcome("recording");
    resumeMetronomeAfterPause(audioState.audioContext);
    startRecordTimer();
    setStatusMessage(metronomeSettings.enabled ? "继续录音中，节拍器已重新对齐到下一拍。" : "继续录音中。");
  }

  function stopRecording() {
    const audioState = audioRef.current;
    if (recordingStateRef.current === "idle") return;
    if (recordingStateRef.current === "countin") {
      recordingStateRef.current = "idle";
      setRecordingState("idle");
      clearRecordTimer();
      cleanupRecorderGraph();
      setCaptureOutcome("waiting");
      setStatusMessage("已取消准备，尚未开始正式录音。");
      return;
    }
    if (recordingStateRef.current === "recording") {
      audioState.recordElapsedBeforePause += (performance.now() - audioState.recordStartedAt) / 1000;
    }
    clearRecordTimer();
    stopMetronome();
    recordingStateRef.current = "idle";
    setRecordingState("idle");
    setRecordDuration(audioState.recordElapsedBeforePause);
    if (audioState.mediaRecorder?.state !== "inactive") {
      try {
        // Flush a short take before stopping so its final audio chunk is not missed.
        audioState.mediaRecorder.requestData();
      } catch {
        // Some browser implementations only emit the final chunk during stop().
      }
      audioState.mediaRecorder.stop();
    } else cleanupRecorderGraph();
  }

  async function handleAudioImport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const supportedExtension = /\.(mp3|wav|m4a|aac|mp4|webm|ogg)$/i.test(file.name);
    if (!file.type.startsWith("audio/") && !supportedExtension) {
      setCaptureOutcome("failure");
      setStatusMessage("请选择 MP3、WAV、M4A、AAC 或其他常见音频文件。");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setCaptureOutcome("failure");
      setStatusMessage("这个音频超过 25MB。请先选择更短的录音再试。 ");
      return;
    }
    try {
      stopRecording();
      const duration = await decodeDuration(file);
      clearAudioSource();
      replaceAudioSource(file, { name: file.name, kind: "import", duration });
      try {
        await createProjectForAudio({
          blob: file,
          name: file.name,
          kind: "import",
          duration
        });
      } catch (storageError) {
        setStatusMessage("音频已导入，但暂时无法保存到本地作品库。 ");
      }
      setCaptureOutcome("complete");
      setStatusMessage("录音已导入。可以先试听，再开始识别。");
      showToast("导入成功");
    } catch (error) {
      setCaptureOutcome("failure");
      setStatusMessage("这个文件暂时无法读取。请尝试 MP3、WAV 或 M4A 格式的录音。");
    }
  }

  async function generateTunedPreview(nextStrength = tuningStrength) {
    const audioState = audioRef.current;
    if (!audioState.recordedBlob) {
      showToast("请先录一段或导入音频");
      return;
    }
    tuningAbortRef.current?.abort();
    const controller = new AbortController();
    tuningAbortRef.current = controller;
    setTuningEnabled(true);
    setTuningStrength(nextStrength);
    setTuningStatus("generating");
    setTuningError("");
    setStatusMessage("正在分析人声音高并生成修音预览，原声会始终保留。 ");
    const startedAt = performance.now();
    try {
      const context = await ensureAudioContext();
      const result = await createTunedVocalPreview(audioState.recordedBlob, context, {
        strength: nextStrength,
        signal: controller.signal,
        onProgress: ({ message }) => setStatusMessage(message)
      });
      if (tuningAbortRef.current !== controller) return;
      replaceTunedAudio(result.blob);
      const diagnostics = {
        ...result.diagnostics,
        tuningDurationMs: Math.round(performance.now() - startedAt)
      };
      setTuningDiagnostics(diagnostics);
      setTuningStatus("ready");
      setTranscriptionSource("tuned");
      await persistCurrentProject({
        tuningEnabled: true,
        tunedAudioBlob: result.blob,
        tuningMode: "free-chromatic",
        tuningStrength: nextStrength,
        tuningVersion: VOCAL_TUNING_VERSION,
        tuningStatus: "ready",
        tuningCreatedAt: new Date().toISOString(),
        tuningDiagnostics: diagnostics,
        transcriptionSource: "tuned",
        storeTranscript: false
      });
      setStatusMessage("修音预览已生成。现在可切换试听原声和修音后人声，再选择用哪个版本转译。 ");
      showToast("修音预览已准备好");
    } catch (error) {
      if (error?.name === "AbortError") {
        setTuningStatus("idle");
        setTuningEnabled(Boolean(audioState.tunedBlob));
        setStatusMessage("已取消生成修音预览，原声仍可正常转译。 ");
        return;
      }
      console.warn("Vocal tuning preview failed:", error);
      setTuningStatus("failed");
      setTuningEnabled(false);
      setTranscriptionSource("original");
      const message = error instanceof Error ? error.message : "修音预览暂时无法生成";
      setTuningError(message);
      await persistCurrentProject({
        tuningEnabled: false,
        tuningStatus: "failed",
        transcriptionSource: "original",
        storeTranscript: false
      });
      setStatusMessage(`${message} 你仍可直接使用原声转译。`);
    } finally {
      if (tuningAbortRef.current === controller) tuningAbortRef.current = null;
    }
  }

  function handleTuningToggle(enabled) {
    if (enabled) {
      void generateTunedPreview(tuningStrength);
      return;
    }
    clearTunedPreview();
    void persistCurrentProject({
      tunedAudioBlob: null,
      tuningEnabled: false,
      tuningStatus: "idle",
      tuningCreatedAt: null,
      tuningDiagnostics: null,
      transcriptionSource: "original",
      storeTranscript: false
    });
    setStatusMessage("已移除修音预览，原始录音没有改变。 ");
  }

  function changeTuningStrength(nextStrength) {
    if (nextStrength === tuningStrength && tuningStatus !== "failed") return;
    setTuningStrength(nextStrength);
    if (tuningEnabled) void generateTunedPreview(nextStrength);
  }

  function cancelTuningPreview() {
    tuningAbortRef.current?.abort();
    tuningAbortRef.current = null;
    setTuningStatus("idle");
    setTuningEnabled(Boolean(audioRef.current.tunedBlob));
  }

  function chooseTranscriptionSource(source) {
    if (source === "tuned" && (!audioRef.current.tunedBlob || tuningStatus !== "ready")) return;
    setTranscriptionSource(source);
    void persistCurrentProject({ transcriptionSource: source, storeTranscript: false });
  }

  function restoreSavedTranscription(source) {
    const project = projectsRef.current.find((item) => item.id === currentProjectIdRef.current);
    const transcript = project?.transcriptions?.[source];
    if (!transcript?.editedNotes?.length) {
      showToast(source === "tuned" ? "修音版还没有独立转译结果" : "原声还没有独立转译结果");
      return;
    }
    recognitionBaselineRef.current = deepClone(transcript.processedDetectedNotes || transcript.interpretedNotes || []);
    updateRecognitionDiagnostics(transcript.recognitionDiagnostics || null);
    const restoredRhythm = normalizeRhythmSource(transcript.rhythm || null);
    setMelody((current) => ({
      ...current,
      ...(transcript.melody || {}),
      // Switching source restores its stored timestamps, not a fresh BPM-derived layout.
      tempo: transcript.melody?.tempo || current.tempo,
      notes: normalizePhraseMetadata(transcript.editedNotes)
    }));
    setRhythmData(restoredRhythm);
    setRhythmPreviewMode(restoredRhythm?.rhythmSource === "quantized" ? "quantized" : "original");
    setShowRhythmPreview(false);
    setTranscriptionSource(source);
    setSelectedNote(null);
    projectStatusRef.current = "recognized";
    void persistCurrentProject({ transcriptionSource: source, storeTranscript: false });
    setStatusMessage("已恢复" + (source === "tuned" ? "修音版" : "原声") + "的已保存曲谱结果。");
  }

  function setRecognizedMelody(nextMelody) {
    stopInstrumentPlayback();
    const recognizedNotes = normalizePhraseMetadata(nextMelody.notes || []).map((note) => ({
      ...note,
      originalMidi: note.midi,
      autoTune: autoTuneEnabled
    }));
    const profile = inferAutoTuneScale(recognizedNotes);
    recognitionBaselineRef.current = deepClone(recognizedNotes);
    setAutoTuneScale(profile);
    const displayedMelody = {
      ...nextMelody,
      notes: recognizedNotes.map((note) => {
        const tunedMidi = autoTuneEnabled ? snapMidiToScale(note.originalMidi, profile.pitchClasses) : note.originalMidi;
        return {
          ...note,
          ...createNote(tunedMidi, note.beats, nextMelody.beatUnitSeconds || 0.55, note.noteSeconds, {
            frequency: midiToFreq(tunedMidi),
            startTime: note.startTime,
            endTime: note.endTime
          })
        };
      })
    };
    const recordedMetronome = audioRef.current.metronomeTiming;
    const nextRhythmData = buildRhythmData(displayedMelody.notes, {
      metronomeEnabled: Boolean(recordedMetronome?.enabled),
      metronomeTimeSignature: recordedMetronome?.metronomeTimeSignature,
      selectedBpm: recordedMetronome?.enabled ? recordedMetronome.metronomeBpm : undefined,
      selectedTimeSignature: recordedMetronome?.enabled ? recordedMetronome.metronomeTimeSignature : undefined,
      bpmSource: recordedMetronome?.enabled ? "metronome" : "detected",
      quantizationMode: "original",
      quantizationGrid: "eighth",
      rhythmSource: "original",
      quantizationEnabled: false,
      naturalTempo: displayedMelody.tempo,
      naturalBeatUnitSeconds: displayedMelody.beatUnitSeconds
    });
    const rhythmMelody = {
      ...displayedMelody,
      // Detected BPM remains annotation metadata until the user explicitly applies a preview.
      beatUnitSeconds: displayedMelody.beatUnitSeconds || 0.55,
      tempo: displayedMelody.tempo || 0,
      notes: nextRhythmData.originalRhythmNotes
    };
    setRhythmData(nextRhythmData);
    setRhythmPreviewMode("original");
    setShowRhythmPreview(false);
    setMelody(rhythmMelody);
    setSelectedNote(null);
    setEditorSnapshot(null);
    setEditorNotesSnapshot(null);
    setLastEdit(null);
    return { processedDetectedNotes: recognizedNotes, displayedMelody: rhythmMelody, autoTuneScale: profile, rhythmData: nextRhythmData };
  }

  async function transcribeCurrentAudio() {
    const audioState = audioRef.current;
    if (recordingStateRef.current !== "idle") {
      pendingTranscribeRef.current = true;
      stopRecording();
      return;
    }
    const selectedAudioBlob = transcriptionSource === "tuned" ? audioState.tunedBlob : audioState.recordedBlob;
    if (!selectedAudioBlob) {
      if (transcriptionSource === "tuned") {
        setStatusMessage("修音版还没有准备好，请先等待生成完成或切换回原声转译。 ");
        return;
      }
      setStatusMessage("先开始哼唱，或导入一段录音后再识别。");
      showToast("还没有录音");
      return;
    }
    setIsRecognizing(true);
    setCaptureOutcome("recognizing");
    setStatusMessage(`正在分析${transcriptionSource === "tuned" ? "修音后人声" : "原声"}的旋律，请稍等一下。 `);
    try {
      const title = melody.title?.trim() || "未命名旋律";
      const context = await ensureAudioContext();
      let modelMelody = null;
      let modelDiagnostics = null;
      let modelErrorMessage = null;
      try {
        const modelResult = await detectMonophonicNotesWithBasicPitch(
          selectedAudioBlob,
          context,
          (progress) => {
            setStatusMessage(`正在分析旋律的音高和起音… ${Math.round(progress * 100)}%`);
          },
          { interpreterMode }
        );
        modelDiagnostics = { ...modelResult.diagnostics, transcriptionSource };
        modelMelody = buildMelodyFromBasicPitchEvents(modelResult.events, title);
      } catch (modelError) {
        // The original local detector remains a real-audio fallback for offline or older browsers.
        console.warn("Basic Pitch transcription failed; using the local pitch tracker.", modelError);
        modelErrorMessage = modelError instanceof Error ? modelError.message : "Basic Pitch 识别未能完成";
      }

      let fallbackMelody = null;
      let usedFastFallback = false;
      if (!modelMelody) {
        setStatusMessage("精细模型暂时不可用，正在使用本地音高分析。 ");
        const realtimeMelody = transcriptionSource === "original" && audioState.lastCapturedFrames.length
          ? buildMelodyFromFrames(audioState.lastCapturedFrames, title, transcriptionMode)
          : null;
        const offlineFrames = await extractFramesFromBlob(selectedAudioBlob, context);
        const offlineMelody = buildMelodyFromFrames(offlineFrames, title, transcriptionMode);
        const standardMelody = [realtimeMelody, offlineMelody]
          .filter(Boolean)
          .sort((left, right) => scoreMelodyCandidate(right) - scoreMelodyCandidate(left))[0];
        // A second pass accepts much shorter stable pitches only when ordinary recognition
        // clearly under-counts the melody. This keeps ornament filtering as the default.
        const fastMelody = transcriptionMode === "ornament"
          ? null
          : buildMelodyFromFrames(offlineFrames, title, "fast");
        usedFastFallback = Boolean(
          fastMelody && (
            !standardMelody ||
            (standardMelody.notes.length <= 3 && fastMelody.notes.length >= standardMelody.notes.length + 2)
          )
        );
        fallbackMelody = usedFastFallback ? fastMelody : standardMelody;
      }

      const transcribed = modelMelody || fallbackMelody;
      if (!transcribed) {
        setStatusMessage("没有识别到足够清楚的旋律。请靠近麦克风，尽量只哼一条旋律后再试。 ");
        return;
      }
      const recognized = setRecognizedMelody(transcribed);
      const diagnostics = modelDiagnostics || {
        recognitionEngine: "local-yin-fallback",
        recognitionVersion: "yin-local-fallback-v1",
        modelLoadStatus: "failed",
        fallbackReason: modelErrorMessage || "Basic Pitch 未返回可用音符",
        inferenceDurationMs: null,
        rawBasicPitchEventCount: 0,
        monophonicEventCount: 0,
        mergedEventCount: 0,
        finalEventCount: transcribed.notes.length,
        finalNoteCount: transcribed.notes.length,
        transcriptionSource,
        interpreterMode,
        interpreterVersion: HUMMING_INTERPRETER_VERSION,
        rawBasicPitchEvents: [],
        monophonicEvents: [],
        mergedEvents: [],
        finalEvents: []
      };
      updateRecognitionDiagnostics(diagnostics);
      projectStatusRef.current = "recognized";
      await persistCurrentProject({
        name: title,
        recognitionStatus: "recognized",
        recognitionVersion: RECOGNITION_VERSION,
        rawBasicPitchNotes: diagnostics.rawBasicPitchEvents || [],
        processedDetectedNotes: recognized.processedDetectedNotes,
        interpretedNotes: diagnostics.interpretedNotes || recognized.processedDetectedNotes,
        originalDetectedNotes: recognized.processedDetectedNotes,
        editedNotes: recognized.displayedMelody.notes,
        recognitionDiagnostics: diagnostics,
        melodyData: recognized.displayedMelody,
        autoTuneScale: recognized.autoTuneScale,
        rhythm: recognized.rhythmData,
        originalRhythmNotes: recognized.rhythmData.originalRhythmNotes,
        quantizedNotes: recognized.rhythmData.quantizedNotes,
        transcriptionSource,
        recognitionEngine: diagnostics.recognitionEngine,
        interpreterMode: diagnostics.interpreterMode || interpreterMode,
        interpreterVersion: diagnostics.interpreterVersion || HUMMING_INTERPRETER_VERSION
      });
      setCaptureOutcome("success");
      setActiveTab("score");
      setStatusMessage(
        modelMelody
          ? "识别完成：已使用音高与起音模型切分音符。点击任意音符可以修正。"
          : usedFastFallback
            ? "已使用兼容识别模式：本地识别已为快速哼唱补回短音。点击任意音符可以修正。"
            : "已使用兼容识别模式：Basic Pitch 暂不可用，当前结果来自本地音高分析。"
      );
      showToast(`识别出 ${transcribed.notes.length} 个音符`);
    } catch (error) {
      setCaptureOutcome("failure");
      setStatusMessage("这段音频无法识别。请换一段更清晰的单旋律录音再试。 ");
    } finally {
      setIsRecognizing(false);
    }
  }

  function stopInstrumentPlayback(reset = true) {
    const audioState = audioRef.current;
    const context = audioState.audioContext;
    playbackRunRef.current += 1;
    audioState.playTimeouts.forEach((timer) => clearTimeout(timer));
    audioState.playTimeouts = [];
    const now = context?.state === "closed" ? undefined : context?.currentTime;
    audioState.sampledInstrumentEngine?.stopAll(now);
    audioState.activeSampleStops = [];
    audioState.activeVoices.forEach((voice) => {
      try {
        if (!Number.isFinite(now)) return;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0.0001, now, 0.03);
        voice.oscillators.forEach((oscillator) => oscillator.stop(now + 0.08));
        if (voice.lfo) voice.lfo.stop(now + 0.08);
      } catch (error) {
        // A voice may already have ended.
      }
    });
    audioState.activeVoices = [];
    setPlayingIndex(-1);
    if (reset) {
      setPlaybackState("idle");
      setResumeIndex(0);
    }
  }

  function getSampledPlaybackEngine(context, audioState) {
    if (!audioState.sampledInstrumentEngine || audioState.sampledInstrumentContext !== context) {
      if (audioState.sampledInstrumentEngine) destroyInstrumentOutput(audioState);
      const output = getInstrumentOutput(context, audioState);
      audioState.sampledInstrumentContext = context;
      audioState.sampledInstrumentEngine = createSampledInstrumentEngine(context, output, {
        onStatus: (status) => setInstrumentLoadState({ ...status, error: "" })
      });
    }
    return audioState.sampledInstrumentEngine;
  }

  async function preloadSampledInstrument(targetInstrument) {
    if (!isSampledInstrument(targetInstrument) || !notes.length) return;
    try {
      // Choosing an instrument is a user gesture, so Safari may safely prepare its audio buffers here.
      const context = await ensureAudioContext();
      const audioState = audioRef.current;
      const sampleEngine = getSampledPlaybackEngine(context, audioState);
      setInstrumentLoadState({ state: "loading", instrumentId: targetInstrument, loaded: 0, total: 0, cached: false, error: "" });
      await sampleEngine.load(targetInstrument, notes.map((note) => note.midi));
    } catch (error) {
      const message = error instanceof Error ? error.message : "音色没有加载完成。";
      setInstrumentLoadState({ state: "fallback", instrumentId: targetInstrument, loaded: 0, total: 0, cached: false, error: message });
    }
  }

  async function resolvePlaybackEngine(context, audioState, targetInstrument, requestedNotes, playbackRun) {
    const destination = getInstrumentOutput(context, audioState);
    if (!isSampledInstrument(targetInstrument)) return { kind: "synth", destination };

    const sampleEngine = getSampledPlaybackEngine(context, audioState);
    try {
      setInstrumentLoadState({ state: "loading", instrumentId: targetInstrument, loaded: 0, total: 0, cached: false, error: "" });
      const loaded = await sampleEngine.load(targetInstrument, requestedNotes);
      if (playbackRunRef.current !== playbackRun) return null;
      return { kind: "sample", destination: getInstrumentOutput(context, audioState), sampleEngine, definition: loaded.definition };
    } catch (error) {
      if (playbackRunRef.current !== playbackRun) return null;
      const message = error instanceof Error ? error.message : "音色没有加载完成。";
      setInstrumentLoadState({ state: "fallback", instrumentId: targetInstrument, loaded: 0, total: 0, cached: false, error: message });
      return { kind: "synth", destination: getInstrumentOutput(context, audioState), fallbackError: message };
    }
  }

  async function playMelody(startAt = 0, playbackNotes = notes, previewKind = "") {
    if (!playbackNotes.length) {
      showToast("还没有可播放的旋律");
      return;
    }

    try {
      const context = await ensureAudioContext();
      const audioState = audioRef.current;
      unlockInstrumentOutput(context, audioState);
      stopInstrumentPlayback(false);
      const playbackRun = playbackRunRef.current;
      const startTime = context.currentTime + 0.06;
      const plan = createPhrasePlaybackPlan(playbackNotes, {
        startAt,
        beatUnitSeconds: 60 / (rhythmData?.selectedBpm || melody.tempo || 80),
        instrument,
        articulation: playbackStyle
      });
      const engine = await resolvePlaybackEngine(context, audioState, instrument, plan.map((entry) => entry.note.midi), playbackRun);
      if (!engine || playbackRunRef.current !== playbackRun) return;

      setPlaybackState("playing");
      setRhythmPreviewPlaying(previewKind);
      setResumeIndex(startAt);
      if (engine.fallbackError) setStatusMessage(engine.fallbackError + " 已暂时使用简化回退音色。");
      let runtimeSampleFallback = false;
      const scheduleSynthVoice = (entry, voiceStart) => {
        const phraseRole = entry.startsPhrase && entry.endsPhrase
          ? "single"
          : entry.startsPhrase
            ? "start"
            : entry.endsPhrase
              ? "end"
              : "middle";
        audioState.activeVoices.push(
          buildInstrumentVoice(
            context,
            instrument,
            midiToFreq(entry.note.midi),
            voiceStart,
            entry.duration + entry.crossfadeSeconds,
            playbackStyle,
            phraseRole,
            engine.destination
          )
        );
      };

      plan.forEach((entry) => {
        const voiceStart = startTime + entry.startOffset;
        if (engine.kind === "sample") {
          try {
            const velocity = entry.startsPhrase ? 86 : 76;
            const duration = Math.max(0.18, entry.duration + (entry.endsPhrase ? 0.025 : entry.crossfadeSeconds));
            const stop = engine.sampleEngine.start(instrument, {
              note: entry.note.midi,
              velocity,
              time: voiceStart,
              duration,
              ampRelease: entry.endsPhrase ? engine.definition.releaseSeconds : Math.min(0.05, entry.crossfadeSeconds + 0.018),
              stopId: "melody-" + playbackRun + "-" + entry.index
            });
            if (typeof stop === "function") audioState.activeSampleStops.push(stop);
          } catch (error) {
            // A loaded sample may still reject an individual note on Safari.
            // Fall back per voice so a one-note score can never become silent.
            runtimeSampleFallback = true;
            scheduleSynthVoice(entry, voiceStart);
          }
        } else {
          scheduleSynthVoice(entry, voiceStart);
        }
        audioState.playTimeouts.push(setTimeout(() => {
          if (playbackRunRef.current !== playbackRun) return;
          setPlayingIndex(entry.index);
          setResumeIndex(entry.index);
        }, Math.max(0, (voiceStart - context.currentTime) * 1000)));
      });

      if (runtimeSampleFallback) {
        setInstrumentLoadState({ state: "fallback", instrumentId: instrument, loaded: 0, total: 0, cached: false, error: "个别采样音符未能启动" });
        setStatusMessage("真实采样有个别音符未能启动，已自动切换到简化回退音色。 ");
      }

      const finalEntry = plan[plan.length - 1];
      const finishTail = engine.kind === "sample" ? engine.definition.releaseSeconds : finalEntry.settings.releaseSeconds;
      const finishAfter = finalEntry.startOffset + finalEntry.duration + finishTail + 0.09;
      audioState.playTimeouts.push(setTimeout(() => {
        if (playbackRunRef.current !== playbackRun) return;
        stopInstrumentPlayback(false);
        setPlaybackState("idle");
        setRhythmPreviewPlaying("");
        setResumeIndex(0);
        setStatusMessage("乐器演奏完成。气口已保留，乐句内的换音会连贯衔接。");
      }, Math.max(0, finishAfter * 1000)));
    } catch (error) {
      stopInstrumentPlayback();
      setRhythmPreviewPlaying("");
      const message = error instanceof Error ? error.message : "乐器声音没有启动，请再试一次。";
      setStatusMessage(message);
      showToast("乐器演奏没有启动");
    }
  }

  function playRhythmPreview(source) {
    const model = currentRhythmModel();
    const previewNotes = source === "quantized" ? model.quantizedNotes : model.originalRhythmNotes;
    if (!previewNotes?.length) {
      showToast("这份节奏预览还没有可播放的音符");
      return;
    }
    stopInstrumentPlayback();
    void playMelody(0, previewNotes, source);
  }

  function pauseMelody() {
    const nextIndex = playingIndex >= 0 ? playingIndex : resumeIndex;
    stopInstrumentPlayback(false);
    setPlaybackState("paused");
    setResumeIndex(nextIndex);
  }

  async function previewSelectedNote() {
    if (!selectedNoteData) return;
    try {
      const context = await ensureAudioContext();
      const audioState = audioRef.current;
      unlockInstrumentOutput(context, audioState);
      stopInstrumentPlayback(false);
      const playbackRun = playbackRunRef.current;
      const engine = await resolvePlaybackEngine(context, audioState, instrument, [selectedNoteData.midi], playbackRun);
      if (!engine || playbackRunRef.current !== playbackRun) return;
      const startAt = context.currentTime + 0.03;
      if (engine.kind === "sample") {
        const stop = engine.sampleEngine.start(instrument, {
          note: selectedNoteData.midi,
          velocity: 82,
          time: startAt,
          duration: Math.max(0.18, selectedNoteData.noteSeconds || 0.55),
          ampRelease: engine.definition.releaseSeconds,
          stopId: "preview-" + playbackRun
        });
        audioState.activeSampleStops = [stop];
      } else {
        audioState.activeVoices = [buildInstrumentVoice(context, instrument, midiToFreq(selectedNoteData.midi), startAt, 0.7, playbackStyle, "single", engine.destination)];
      }
      setStatusMessage(engine.fallbackError ? engine.fallbackError + " 已使用简化回退音色试听。" : "正在试听这个音。 ");
    } catch (error) {
      const message = error instanceof Error ? error.message : "乐器声音没有启动，请再试一次。";
      setStatusMessage(message);
      showToast("单音试听没有启动");
    }
  }

  function openNoteEditor(index) {
    if (selectedNote === index) {
      closeNoteEditor(true);
      return;
    }
    if (selectedNote !== null && editorNotesSnapshot) {
      const previousSnapshot = deepClone(editorNotesSnapshot);
      setMelody((current) => {
        const next = deepClone(current);
        next.notes = previousSnapshot;
        return next;
      });
    }
    setSelectedNote(index);
    setEditorSnapshot(deepClone(notes[index]));
    setEditorNotesSnapshot(deepClone(notes));
    setManualPitchInput(midiToPitchName(notes[index].midi));
  }

  function updateSelectedPitch(delta) {
    if (selectedNote === null) return;
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      if (!note) return current;
      const nextMidi = clamp(note.midi + delta, 48, 84);
      next.notes[selectedNote] = {
        ...note,
        ...createNote(nextMidi, note.beats, next.beatUnitSeconds, note.noteSeconds, {
          frequency: midiToFreq(nextMidi), startTime: note.startTime, endTime: note.endTime
        }),
        originalMidi: nextMidi,
        autoTune: false
      };
      return next;
    });
    if (selectedNoteData) setManualPitchInput(midiToPitchName(clamp(selectedNoteData.midi + delta, 48, 84)));
  }

  function applyManualPitch() {
    if (!selectedNoteData) return;
    const midi = parsePitchInput(manualPitchInput, selectedNoteData.midi);
    if (midi === null) {
      setStatusMessage("请输入类似 C4、F#4 或 Bb3 的音名。 ");
      return;
    }
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      next.notes[selectedNote] = {
        ...note,
        ...createNote(midi, note.beats, next.beatUnitSeconds, note.noteSeconds, {
          frequency: midiToFreq(midi), startTime: note.startTime, endTime: note.endTime
        }),
        originalMidi: midi,
        autoTune: false
      };
      return next;
    });
    setManualPitchInput(midiToPitchName(midi));
    setStatusMessage(`已手动改为 ${midiToPitchName(midi)}。自动修音已在这个音上关闭。`);
  }

  function toggleSelectedAutoTune(enabled) {
    if (selectedNote === null) return;
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      const originalMidi = note.originalMidi ?? note.midi;
      // A note remembers its own preference; the global switch can temporarily bypass it.
      const tunedMidi = enabled && autoTuneEnabled && autoTuneScale
        ? snapMidiToScale(originalMidi, autoTuneScale.pitchClasses)
        : originalMidi;
      next.notes[selectedNote] = {
        ...note,
        ...createNote(tunedMidi, note.beats, next.beatUnitSeconds, note.noteSeconds, {
          frequency: midiToFreq(tunedMidi), startTime: note.startTime, endTime: note.endTime
        }),
        originalMidi,
        autoTune: enabled
      };
      return next;
    });
  }

  function toggleGlobalAutoTune(enabled) {
    setAutoTuneEnabled(enabled);
    setMelody((current) => ({
      ...current,
      notes: current.notes.map((note) => {
        const originalMidi = note.originalMidi ?? note.midi;
        const keepNoteTune = note.autoTune !== false;
        const tunedMidi = enabled && keepNoteTune && autoTuneScale
          ? snapMidiToScale(originalMidi, autoTuneScale.pitchClasses)
          : originalMidi;
        return {
          ...note,
          ...createNote(tunedMidi, note.beats, current.beatUnitSeconds, note.noteSeconds, {
            frequency: midiToFreq(tunedMidi), startTime: note.startTime, endTime: note.endTime
          }),
          originalMidi,
          // Do not erase a per-note "off" choice when the global switch changes.
          autoTune: keepNoteTune
        };
      })
    }));
    setStatusMessage(
      enabled
        ? "自动修音已开启，轻微跑音会贴近旋律的自然音阶；单音关闭的设置会被保留。"
        : "自动修音已关闭，已恢复原始识别音高；单音设置会在下次开启时保留。"
    );
    queueProjectSave("edited");
  }

  function selectInstrument(nextInstrument) {
    if (nextInstrument === instrument) return;
    stopInstrumentPlayback();
    setInstrument(nextInstrument);
    setInstrumentLoadState({ state: "idle", instrumentId: nextInstrument, loaded: 0, total: 0, cached: false, error: "" });
    queueProjectSave(projectStatusRef.current);
    if (isSampledInstrument(nextInstrument) && notes.length) void preloadSampledInstrument(nextInstrument);
  }

  function restoreOriginalNote() {
    if (selectedNote === null || !recognitionBaselineRef.current[selectedNote]) return;
    const baseline = deepClone(recognitionBaselineRef.current[selectedNote]);
    setMelody((current) => {
      const next = deepClone(current);
      next.notes[selectedNote] = { ...baseline, autoTune: false };
      return next;
    });
    setStatusMessage("已恢复为最初识别到的音高。 ");
  }

  function closeNoteEditor(discardChanges) {
    if (discardChanges && editorNotesSnapshot) {
      setMelody((current) => {
        const next = deepClone(current);
        next.notes = deepClone(editorNotesSnapshot);
        return next;
      });
    }
    setSelectedNote(null);
    setEditorSnapshot(null);
    setEditorNotesSnapshot(null);
    setManualPitchInput("");
  }

  function confirmNoteEdit() {
    if (selectedNote === null || !editorSnapshot) return;
    setLastEdit({ beforeNotes: deepClone(editorNotesSnapshot) });
    setStatusMessage("修改已保存到曲谱。 ");
    showToast("音符已更新");
    closeNoteEditor(false);
    queueProjectSave("edited");
  }

  function undoLastEdit() {
    if (!lastEdit) return;
    setMelody((current) => {
      const next = deepClone(current);
      next.notes = deepClone(lastEdit.beforeNotes);
      if (lastEdit.beforeRhythm) {
        Object.assign(next, lastEdit.beforeRhythm);
      }
      return next;
    });
    setLastEdit(null);
    setStatusMessage("已撤销上一次修改。 ");
    queueProjectSave("edited");
  }

  function currentRhythmModel() {
    const stored = normalizeRhythmSource(rhythmData) || buildRhythmData(notes, {
      selectedBpm: melody.tempo || DEFAULT_RHYTHM_SETTINGS.selectedBpm,
      selectedTimeSignature: "4/4",
      quantizationMode: "original",
      quantizationGrid: "eighth",
      rhythmSource: "original",
      quantizationEnabled: false,
      naturalTempo: melody.tempo,
      naturalBeatUnitSeconds: melody.beatUnitSeconds
    });
    if (!notes.length) return stored;
    const formalIsQuantized = stored.rhythmSource === "quantized" && Boolean(stored.quantizationEnabled);
    const annotatedFormalNotes = annotateOriginalRhythmNotes(notes, stored);
    // melody.notes is the single formal source. Only the matching branch receives its display metadata.
    return {
      ...stored,
      rhythmSource: formalIsQuantized ? "quantized" : "original",
      quantizationEnabled: formalIsQuantized,
      ...(formalIsQuantized
        ? { quantizedNotes: annotatedFormalNotes.notes, quantizedRests: annotatedFormalNotes.rests, quantizedMeasures: annotatedFormalNotes.measures }
        : { originalRhythmNotes: annotatedFormalNotes.notes, originalRests: annotatedFormalNotes.rests, originalMeasures: annotatedFormalNotes.measures })
    };
  }

  function updateRhythmPreview(patch = {}) {
    if (!notes.length) return;
    const base = currentRhythmModel();
    const formalIsQuantized = base.rhythmSource === "quantized" && Boolean(base.quantizationEnabled);
    const originalNotes = base.originalRhythmNotes?.length ? base.originalRhythmNotes : annotateOriginalRhythmNotes(notes, base).notes;
    const next = {
      ...base,
      ...patch,
      originalRhythmNotes: deepClone(originalNotes),
      originalRests: annotateOriginalRhythmNotes(originalNotes, base).rests,
      selectedBpm: Math.max(40, Math.min(200, Number(patch.selectedBpm ?? base.selectedBpm) || 80)),
      selectedTimeSignature: getTimeSignature(patch.selectedTimeSignature || base.selectedTimeSignature).value,
      quantizationGrid: patch.quantizationGrid || base.quantizationGrid || "eighth",
      // Selecting a preview never changes the currently formal source.
      rhythmSource: formalIsQuantized ? "quantized" : "original",
      quantizationEnabled: formalIsQuantized
    };
    if (next.quantizationMode !== "original") {
      const preview = quantizeRhythmNotes(originalNotes, next);
      Object.assign(next, {
        quantizedNotes: preview.quantizedNotes,
        quantizedRests: preview.rests,
        quantizedMeasures: preview.measures,
        totalMeasures: preview.totalMeasures,
        quantizationVersion: preview.quantizationVersion,
        quantizationDiagnostics: preview.analysis,
        quantizationPreviewStatus: preview.analysis?.blocked ? "blocked" : "ready"
      });
      setRhythmPreviewMode("quantized");
      setStatusMessage(preview.analysis?.blocked
        ? "这段旋律不太适合自动整理，已继续保留原节奏。"
        : preview.analysis?.bpmAmbiguous
          ? "已生成整理预览，但速度可能存在半速或双速歧义，请先试听。"
          : "已生成节奏整理预览。当前正式曲谱和播放仍保留自然节奏。 ");
    } else {
      Object.assign(next, {
        quantizedNotes: [], quantizedRests: [], quantizedMeasures: [],
        quantizationDiagnostics: null, quantizationPreviewStatus: "idle"
      });
      setRhythmPreviewMode("original");
      setStatusMessage("当前保留你的自然节奏。 ");
    }
    setRhythmData(next);
    setShowRhythmPreview(true);
  }

  function applyRhythmPreview() {
    const model = currentRhythmModel();
    const applyingQuantized = rhythmPreviewMode === "quantized" && model.quantizedNotes?.length;
    if (applyingQuantized && model.quantizationDiagnostics?.blocked) {
      setStatusMessage("这份整理预览改变幅度过大，未应用。请保留原节奏或换一个速度后再试。 ");
      showToast("整理预览不适合应用");
      return;
    }
    const nextNotes = applyingQuantized ? model.quantizedNotes : model.originalRhythmNotes;
    if (!nextNotes?.length) return;
    const previousRhythmVersion = { rhythmSource: model.rhythmSource || "original", notes: deepClone(notes) };
    const nextRhythm = {
      ...model,
      rhythmSource: applyingQuantized ? "quantized" : "original",
      quantizationEnabled: applyingQuantized,
      quantizationMode: applyingQuantized ? model.quantizationMode : "original",
      quantizationPreviewStatus: applyingQuantized ? "applied" : "idle",
      lastRhythmAction: applyingQuantized ? "apply-quantized-rhythm" : "keep-original-rhythm",
      previousRhythmVersion,
      rhythmUpdatedAt: new Date().toISOString()
    };
    setMelody((current) => ({
      ...current,
      // A detected BPM is only adopted after an explicit apply. Original notes retain their own timings.
      tempo: applyingQuantized ? nextRhythm.selectedBpm : (nextRhythm.naturalTempo || current.tempo),
      beatUnitSeconds: applyingQuantized ? 60 / nextRhythm.selectedBpm : (nextRhythm.naturalBeatUnitSeconds || current.beatUnitSeconds),
      notes: deepClone(nextNotes)
    }));
    setRhythmData(nextRhythm);
    setRhythmPreviewMode(applyingQuantized ? "quantized" : "original");
    setShowRhythmPreview(false);
    setLastEdit({ beforeNotes: previousRhythmVersion.notes, beforeRhythm: { tempo: melody.tempo, beatUnitSeconds: melody.beatUnitSeconds } });
    setStatusMessage(applyingQuantized ? "已应用整理后的节奏。原节奏仍安全保留，可以一键恢复。" : "已保留原节奏。需要时仍可生成新的整理预览。 ");
    showToast(applyingQuantized ? "已应用整理节奏" : "已保留原节奏");
    queueProjectSave("edited");
  }

  function restoreOriginalRhythm() {
    const model = currentRhythmModel();
    if (!model.originalRhythmNotes?.length) return;
    const restored = {
      ...model,
      rhythmSource: "original",
      quantizationEnabled: false,
      quantizationMode: "original",
      quantizedNotes: [], quantizedRests: [], quantizedMeasures: [],
      quantizationDiagnostics: null,
      quantizationPreviewStatus: "idle",
      lastRhythmAction: "restore-original-rhythm",
      previousRhythmVersion: { rhythmSource: model.rhythmSource, notes: deepClone(notes) },
      rhythmUpdatedAt: new Date().toISOString()
    };
    setMelody((current) => ({
      ...current,
      // Use the pre-application timestamps verbatim; never reconstruct them from BPM.
      tempo: restored.naturalTempo || current.tempo,
      beatUnitSeconds: restored.naturalBeatUnitSeconds || current.beatUnitSeconds,
      notes: deepClone(restored.originalRhythmNotes)
    }));
    setRhythmData(restored);
    setRhythmPreviewMode("original");
    setShowRhythmPreview(false);
    setStatusMessage("已恢复最初的自然节奏。音高、气口、原始音频和识别数据都没有改变。");
    showToast("已恢复原节奏");
    queueProjectSave("edited");
  }

  function copyRhythmJson() {
    if (!notes.length) return;
    const model = currentRhythmModel();
    const exportData = createRhythmExport({ notes, rhythm: model, title: melody.title });
    const text = JSON.stringify(exportData, null, 2);
    const fallbackCopy = () => {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    };
    Promise.resolve(navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : fallbackCopy())
      .then(() => showToast("节奏数据已复制"))
      .catch(() => setStatusMessage("浏览器没有允许复制节奏数据，请在普通浏览器标签页中重试。"));
  }

  function adjustSelectedRhythm(target, direction) {
    if (selectedNote === null || !selectedNoteData) return;
    const model = currentRhythmModel();
    const gridBeats = (QUANTIZATION_GRIDS[model.quantizationGrid] || QUANTIZATION_GRIDS.eighth).beats;
    const stepSeconds = (60 / Math.max(40, model.selectedBpm || 80)) * gridBeats;
    const changed = deepClone(notes);
    const note = changed[selectedNote];
    const previous = changed[selectedNote - 1];
    const next = changed[selectedNote + 1];
    const start = Number(note.startTime) || 0;
    const duration = Math.max(0.05, Number(note.noteSeconds || note.durationSeconds) || stepSeconds);
    if (target === "start") {
      const minimumStart = previous?.hasBreathAfter ? (Number(previous.endTime) || 0) : Math.max(0, Number(previous?.startTime) || 0);
      const nextStart = Math.max(minimumStart, start + direction * stepSeconds);
      note.startTime = nextStart;
      note.endTime = Math.max(nextStart + 0.05, Number(note.endTime) || start + duration);
    } else {
      const maximumEnd = next && note.phraseId !== next.phraseId ? Number(next.startTime) || Infinity : Infinity;
      note.endTime = Math.min(maximumEnd, Math.max(start + 0.05, start + duration + direction * stepSeconds));
    }
    note.noteSeconds = note.endTime - note.startTime;
    note.durationSeconds = note.noteSeconds;
    const annotated = annotateOriginalRhythmNotes(changed, model);
    setMelody((current) => ({ ...current, notes: annotated.notes }));
    setRhythmData((current) => ({
      ...(current || model),
      ...(current?.rhythmSource === "quantized" ? { quantizedNotes: annotated.notes } : { originalRhythmNotes: annotated.notes }),
      lastRhythmAction: target === "start" ? "manual-start-adjustment" : "manual-duration-adjustment",
      rhythmUpdatedAt: new Date().toISOString()
    }));
    setStatusMessage(target === "start" ? "已调整音符起始位置。" : "已调整音符时值。");
    queueProjectSave("edited");
  }

  function refreshPhraseTiming(nextNotes) {
    const groups = new Map();
    nextNotes.forEach((note, index) => {
      const phraseId = note.phraseId || `phrase-${index + 1}`;
      note.phraseId = phraseId;
      if (!groups.has(phraseId)) groups.set(phraseId, []);
      groups.get(phraseId).push(note);
    });
    groups.forEach((phraseNotes) => {
      const start = phraseNotes[0].startTime ?? 0;
      const final = phraseNotes[phraseNotes.length - 1];
      const end = final.endTime ?? start + (final.noteSeconds || 0);
      phraseNotes.forEach((note, index) => {
        note.phraseStart = start;
        note.phraseEnd = end;
        note.hasBreathBefore = index === 0 && note.hasBreathBefore === true;
        note.hasBreathAfter = index === phraseNotes.length - 1 && note.hasBreathAfter === true;
      });
    });
    return nextNotes;
  }

  function splitSelectedNote() {
    if (selectedNote === null || !selectedNoteData) return;
    const duration = Math.max(0.08, selectedNoteData.noteSeconds || selectedNoteData.beats * (melody.beatUnitSeconds || 0.55));
    if (duration < 0.16) {
      showToast("这个音太短，不适合再拆分");
      return;
    }
    const timestamp = new Date().toISOString();
    setMelody((current) => {
      const next = deepClone(current);
      next.notes = refreshPhraseTiming(splitManualNote(next.notes, selectedNote, {
        beatUnitSeconds: next.beatUnitSeconds,
        timestamp,
        createNote: (midi, beats, unit, seconds, details) => createNote(midi, beats, unit, seconds, details)
      }));
      return next;
    });
    setStatusMessage("已从这里拆成两个连续音。第二个音默认继承原音高，可继续修改。");
    queueProjectSave("edited");
  }

  function toggleBreathAfterSelected() {
    if (selectedNote === null || !selectedNoteData) return;
    const hasBreath = Boolean(selectedNoteData.hasBreathAfter);
    setMelody((current) => {
      const next = deepClone(current);
      const note = next.notes[selectedNote];
      const following = next.notes[selectedNote + 1];
      if (!note || !following) return current;
      if (hasBreath) {
        const phraseId = note.phraseId;
        note.hasBreathAfter = false;
        delete note.manualBreathAfter;
        for (let index = selectedNote + 1; index < next.notes.length; index += 1) {
          const candidate = next.notes[index];
          candidate.phraseId = phraseId;
          candidate.hasBreathBefore = false;
          delete candidate.manualBreathBefore;
          if (candidate.hasBreathAfter) break;
        }
      } else {
        const nextPhraseId = `phrase-manual-${Date.now()}`;
        note.hasBreathAfter = true;
        note.manualBreathAfter = true;
        for (let index = selectedNote + 1; index < next.notes.length; index += 1) {
          const candidate = next.notes[index];
          candidate.phraseId = nextPhraseId;
          candidate.hasBreathBefore = index === selectedNote + 1;
          if (index === selectedNote + 1) candidate.manualBreathBefore = true;
          if (candidate.hasBreathAfter) break;
        }
      }
      next.notes = refreshPhraseTiming(next.notes);
      return next;
    });
    setStatusMessage(hasBreath ? "已删除气口，两个音会作为同一乐句连奏。" : "已添加气口，播放会在这里自然换气后重新起音。");
    queueProjectSave("edited");
  }

  function mergeWithNeighbor(offset) {
    if (selectedNote === null) return;
    const neighbourIndex = selectedNote + offset;
    const currentNote = notes[selectedNote];
    const neighbour = notes[neighbourIndex];
    if (!neighbour || !currentNote || neighbour.midi !== currentNote.midi) return;
    const firstIndex = Math.min(selectedNote, neighbourIndex);
    const timestamp = new Date().toISOString();
    setMelody((current) => {
      const next = deepClone(current);
      next.notes = refreshPhraseTiming(mergeManualNotes(next.notes, selectedNote, neighbourIndex, {
        beatUnitSeconds: next.beatUnitSeconds,
        timestamp,
        createNote: (midi, beats, unit, seconds, details) => createNote(midi, beats, unit, seconds, details)
      }));
      return next;
    });
    setSelectedNote(firstIndex);
    setStatusMessage("相同音高已合并，起止时间和持续时间已按两个音的完整范围更新。 ");
    queueProjectSave("edited");
  }

  useEffect(() => {
    let active = true;
    async function loadLocalProjects() {
      try {
        const storedProjects = await listProjects();
        if (!active) return;
        projectsRef.current = storedProjects;
        setProjects(storedProjects);
        const lastProjectId = window.localStorage.getItem(LAST_PROJECT_KEY);
        const lastProject = lastProjectId
          ? storedProjects.find((project) => project.id === lastProjectId)
          : null;
        if (lastProject && !hasRestoredProjectRef.current) {
          hasRestoredProjectRef.current = true;
          await restoreProject(lastProject);
        }
      } catch (error) {
        if (active) setStatusMessage("本地作品库暂时无法读取。请检查浏览器的存储权限。 ");
      } finally {
        if (active) setLibraryLoading(false);
      }
    }
    void loadLocalProjects();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!projectRevision || !currentProjectId) return undefined;
    const timer = setTimeout(() => {
      void persistCurrentProject({ recognitionStatus: projectStatusRef.current }).catch(() => {
        setStatusMessage("修改已保留在当前页面，但暂时无法写入本地作品库。 ");
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [projectRevision, currentProjectId]);

  useEffect(() => () => {
    clearRecordTimer();
    cleanupRecorderGraph();
    stopInstrumentPlayback();
    destroyInstrumentOutput(audioRef.current);
    if (audioRef.current.recordedUrl) URL.revokeObjectURL(audioRef.current.recordedUrl);
    tuningAbortRef.current?.abort();
    if (audioRef.current.tunedUrl) URL.revokeObjectURL(audioRef.current.tunedUrl);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const hasAudio = Boolean(voicePreviewUrl);
  const sourceDescription = sourceInfo.name || "尚未选择录音";
  const instrumentLabel = { Piano: "钢琴", Mallet: "木琴", Guitar: "吉他", Violin: "小提琴", Flute: "长笛" }[instrument] || "乐器";
  const canMergePrevious = selectedNote !== null && notes[selectedNote - 1]?.midi === selectedNoteData?.midi;
  const canMergeNext = selectedNote !== null && notes[selectedNote + 1]?.midi === selectedNoteData?.midi;

  function switchTab(tab) {
    setActiveTab(tab);
    if (tab !== "score") closeNoteEditor(true);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  return (
    <div className="product-app">
      <main className="product-content">
        {activeTab === "capture" ? (
          <section className="screen capture-screen">
            <div className="capture-hero">
              <div className="hero-note" aria-hidden="true"><AppIcon name="logo" size={22} /></div>
              <span className="eyebrow">灵感捕捉站</span>
              <h1>哼一下，把脑海里的旋律变成歌。</h1>
              <p>不懂乐理也没关系。随口哼一段，Hummely 帮你识别旋律、生成曲谱，再配上伴奏。</p>
            </div>

            <section className={`metronome-settings${metronomeSettings.enabled ? " enabled" : ""}`} aria-label="节奏提示">
              <div className="metronome-head">
                <div>
                  <strong>节奏提示</strong>
                  <small>开启后，圆盘会按照固定速度跳动，跟着圆盘哼唱，会更容易整理节奏。</small>
                </div>
                <label className="metronome-toggle">
                  <input
                    type="checkbox"
                    checked={metronomeSettings.enabled}
                    onChange={(event) => setMetronomeSettings((current) => event.target.checked ? ({
                      ...current,
                      enabled: true,
                      speed: METRONOME_SPEEDS[current.speed] ? current.speed : "medium",
                      bpm: METRONOME_SPEEDS[current.speed]?.bpm || DEFAULT_METRONOME_SETTINGS.bpm,
                      timeSignature: "4/4",
                      countInMeasures: 0,
                      cueMode: { ...current.cueMode, audio: false, visual: true, vibrate: false }
                    }) : ({ ...current, enabled: false }))}
                  />
                  <span>{metronomeSettings.enabled ? "已开启" : "关闭"}</span>
                </label>
              </div>
              {metronomeSettings.enabled ? <div className="metronome-simple-controls">
                <div className="metronome-choice-row" role="group" aria-label="提示方式">
                  <span>提示方式</span>
                  <div className="metronome-segmented-control">
                    <button className={!metronomeSettings.cueMode.audio ? "active" : ""} onClick={() => setMetronomeSettings((current) => ({ ...current, countInMeasures: 0, timeSignature: "4/4", cueMode: { ...current.cueMode, audio: false, visual: true, vibrate: false } }))}>只看圆盘</button>
                    <button className={metronomeSettings.cueMode.audio ? "active" : ""} onClick={() => setMetronomeSettings((current) => ({ ...current, countInMeasures: 0, timeSignature: "4/4", cueMode: { ...current.cueMode, audio: true, visual: true, vibrate: false } }))}>听节拍声</button>
                  </div>
                </div>
                <div className="metronome-choice-row" role="group" aria-label="速度">
                  <span>速度</span>
                  <div className="metronome-segmented-control speed-control">
                    {Object.entries(METRONOME_SPEEDS).map(([value, speed]) => <button key={value} className={metronomeSettings.speed === value ? "active" : ""} onClick={() => setMetronomeSettings((current) => ({ ...current, speed: value, bpm: speed.bpm, countInMeasures: 0, timeSignature: "4/4", soundPreset: "warmWood" }))}><strong>{speed.label}</strong><small>{speed.bpm} BPM</small></button>)}
                  </div>
                </div>
                {metronomeSettings.cueMode.audio ? <p className="headphone-note">建议佩戴耳机，避免节拍声被录进去。</p> : null}
              </div> : null}
            </section>

            <section className={`record-card capture-${captureOutcome}`} aria-live="polite">
              <div className="record-card-topline">
                <span className="capture-state-dot" />
                <span>{captureOutcome === "countin" ? "正在准备录音" : captureOutcome === "recording" ? "正在聆听你的旋律" : captureOutcome === "paused" ? "录音已暂停" : captureOutcome === "recognizing" ? "正在识别旋律" : captureOutcome === "success" ? "识别完成" : captureOutcome === "failure" ? "需要再试一次" : hasAudio ? "录音完成" : "准备好开始哼唱"}</span>
              </div>

              <div className="capture-vinyl-stage">
                <ReactiveVinyl audioRef={audioRef} listening={captureOutcome === "recording" || captureOutcome === "countin"} paused={captureOutcome === "paused"} beat={metronomeBeat}>
                  {captureOutcome === "recording" || captureOutcome === "paused" || captureOutcome === "countin" ? (
                    <button className="vinyl-stop-button" onClick={stopRecording} aria-label="结束录音">
                      <AppIcon name="stop" size={19} />
                      <span>结束录音</span>
                    </button>
                  ) : <span className="vinyl-idle-label" aria-hidden="true">旋律</span>}
                </ReactiveVinyl>
              </div>

              {captureOutcome === "recording" || captureOutcome === "paused" || captureOutcome === "countin" ? (
                captureOutcome === "countin" ? <div className="live-recording-content count-in-content"><div className="recording-clock"><strong>正在准备</strong><span>圆盘会提示开始时机</span></div><p className="live-pitch">准备结束后会开始录音。</p><button className="record-finish" onClick={stopRecording}><AppIcon name="stop" size={16} />取消准备</button></div> :
                <div className="live-recording-content">
                  <div className="recording-clock"><strong>{formatTime(recordDuration)}</strong><span>{captureOutcome === "paused" ? "暂停中，计时已停止" : "正在录音"}</span></div>
                  <p className="live-pitch">{captureOutcome === "recording" ? (livePitch === "--" ? "自然哼唱就好" : `自然哼唱就好 · 正在捕捉 ${livePitch}`) : "可以继续哼唱，或点击圆盘中心结束录音"}</p>
                  <div className="record-action-row circular-record-actions">
                    <button className="record-secondary" onClick={captureOutcome === "paused" ? resumeRecording : pauseRecording}>
                      <AppIcon name={captureOutcome === "paused" ? "play" : "pause"} size={17} />
                      {captureOutcome === "paused" ? "继续哼唱" : "暂停"}
                    </button>
                    <button className="record-finish" onClick={stopRecording}>
                      <AppIcon name="stop" size={16} />结束哼唱
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="recording-clock"><strong>{hasAudio ? formatTime(recordDuration) : "00:00"}</strong><span>{captureOutcome === "recognizing" ? "请稍候，正在整理你的旋律" : captureOutcome === "success" ? "曲谱已准备好" : hasAudio ? "录音完成，可以试听后开始识别" : "点击按钮开始"}</span></div>
                  {hasAudio ? (
                    <>
                      <div className="record-source-row"><span>{sourceLabel(sourceInfo.kind)}</span><strong>{sourceDescription}</strong><button onClick={clearAudioSource} aria-label="移除当前录音">移除</button></div>
                      <label className="project-name-field">
                        <span>作品名称</span>
                        <input value={melody.title} maxLength="40" onChange={(event) => updateProjectName(event.target.value)} onBlur={commitProjectName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder="未命名旋律" />
                      </label>
                      <OriginalAudioPlayer url={voicePreviewUrl} fallbackDuration={sourceInfo.duration} label="原声" />
                      <section className={`vocal-tuning-panel status-${tuningStatus}`} aria-label="转译前自动修音">
                        <label className="vocal-tuning-toggle">
                          <input type="checkbox" checked={tuningEnabled} disabled={tuningStatus === "generating"} onChange={(event) => handleTuningToggle(event.target.checked)} />
                          <span><strong>转译前自动修音</strong><small>生成新的本地人声音频，原声不会被覆盖。</small></span>
                        </label>
                        {tuningEnabled ? <div className="vocal-tuning-details">
                          <div className="tuning-strength-row" role="group" aria-label="修音强度">
                            <span>修音强度</span>
                            <button className={tuningStrength === "natural" ? "active" : ""} disabled={tuningStatus === "generating"} onClick={() => changeTuningStrength("natural")}>自然</button>
                            <button className={tuningStrength === "strong" ? "active" : ""} disabled={tuningStatus === "generating"} onClick={() => changeTuningStrength("strong")}>明显</button>
                          </div>
                          {tuningStatus === "generating" ? <div className="tuning-progress"><span className="mini-spinner" />正在生成修音预览… <button onClick={cancelTuningPreview}>取消</button></div> : null}
                          {tuningStatus === "failed" ? <p className="tuning-error">{tuningError || "修音预览没有生成，仍可使用原声转译。"}</p> : null}
                          {tuningStatus === "ready" && tunedPreviewUrl ? <>
                            <div className="audio-source-choice" role="group" aria-label="转译来源">
                              <button className={transcriptionSource === "original" ? "active" : ""} onClick={() => chooseTranscriptionSource("original")}>试听原声</button>
                              <button className={transcriptionSource === "tuned" ? "active" : ""} onClick={() => chooseTranscriptionSource("tuned")}>试听修音后</button>
                            </div>
                            {transcriptionSource === "tuned" ? <OriginalAudioPlayer url={tunedPreviewUrl} fallbackDuration={sourceInfo.duration} label="修音后人声" /> : null}
                            <p className="transcription-source-note">当前将使用<strong>{transcriptionSource === "tuned" ? "修音后版本" : "原声"}</strong>进行转译，两种版本都会经过相同的人声音符整理。</p>
                          </> : null}
                        </div> : null}
                      </section>
                      <div className="completed-actions">
                        {captureOutcome === "success" ? <button className="primary-action compact-primary" onClick={() => switchTab("score")}><AppIcon name="score" size={18} />查看曲谱</button> : <button className="primary-action compact-primary" disabled={isRecognizing || (transcriptionSource === "tuned" && tuningStatus !== "ready")} onClick={transcribeCurrentAudio}><AppIcon name="sparkle" size={18} />{isRecognizing ? "正在识别..." : `使用${transcriptionSource === "tuned" ? "修音版" : "原声"}开始识别`}</button>}
                        <button className="re-record-button" onClick={prepareForNewRecording}><AppIcon name="refresh" size={17} />重新录制</button>
                      </div>
                    </>
                  ) : (
                    <button className="main-record-button" onClick={startRecording} disabled={isRecognizing}>
                      <AppIcon name="microphone" size={26} />开始哼唱
                    </button>
                  )}
                  {!hasAudio && captureOutcome !== "failure" ? <p className="record-tip">保持自然就好，哼 4 到 12 秒会更容易识别。</p> : null}
                </>
              )}
            </section>

            <button className="import-button" onClick={() => importInputRef.current?.click()}>
              <span className="import-icon"><AppIcon name="upload" size={21} /></span><div><strong>导入手机录音</strong><small>支持 MP3、WAV、M4A、AAC，最大 25MB</small></div><AppIcon name="chevron" size={18} />
            </button>
            <input ref={importInputRef} className="file-input" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.mp4,.webm,.ogg" onChange={handleAudioImport} />

            <section className={`advanced-settings${showAdvancedSettings ? " open" : ""}`}>
              <button className="advanced-settings-trigger" onClick={() => setShowAdvancedSettings((current) => !current)} aria-expanded={showAdvancedSettings}>
                <span className="settings-icon"><AppIcon name="sliders" size={18} /></span>
                <span><strong>高级识别设置</strong><small>默认设置已适合大多数哼唱</small></span>
                <span className="advanced-chevron"><AppIcon name="chevron" size={18} /></span>
              </button>
              {showAdvancedSettings ? <div className="advanced-settings-content">
                <p>选择整理人声音符的程度。无论使用原声还是修音版，都会应用这个设置。</p>
                <div className="transcription-mode-options">
                  {Object.entries(HUMMING_INTERPRETER_MODES).map(([value, profile]) => (
                    <button key={value} className={interpreterMode === value ? "active" : ""} onClick={() => setInterpreterMode(value)}>
                      <strong>{profile.label}</strong><small>{profile.shortDescription}</small>
                    </button>
                  ))}
                </div>
                <span className="advanced-setting-description">当前：{HUMMING_INTERPRETER_MODES[interpreterMode].description}</span>
              </div> : null}
            </section>
            <p className="screen-feedback" role="status">{statusMessage}</p>
          </section>
        ) : null}

        {activeTab === "library" ? (
          <section className="screen library-screen">
            <div className="library-page-head">
              <span className="eyebrow">本地作品库</span>
              <h1>我的创作</h1>
              <p>你的录音和曲谱仅保存在当前设备和浏览器中，清除浏览器数据后可能丢失。</p>
            </div>

            {libraryLoading ? <div className="library-loading">正在读取本地作品…</div> : projects.length ? (
              <div className="project-library-list">
                {projects.map((project) => {
                  const noteCount = project.editedNotes?.length || project.originalDetectedNotes?.length || 0;
                  return (
                    <article className="project-library-card" key={project.id}>
                      <button className="project-library-open" onClick={() => openProject(project.id)}>
                        <div className="project-library-card-top"><span className={`project-status status-${project.recognitionStatus || "pending"}`}>{projectStatusLabel(project.recognitionStatus)}</span><time>{formatProjectDate(project.updatedAt)}</time></div>
                        <strong>{project.name}</strong>
                        <div className="project-library-meta"><span>{projectSourceLabel(project.sourceType)}</span><span>{formatTime(project.duration || 0)}</span>{noteCount ? <span>{noteCount} 个音符</span> : null}</div>
                      </button>
                      <button className="project-delete-button" onClick={() => deleteProject(project)} aria-label={`删除${project.name}`}>删除</button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <section className="library-empty-state">
                <span className="library-empty-note"><AppIcon name="logo" size={27} /></span>
                <strong>还没有保存的旋律</strong>
                <p>完成第一次哼唱后，它会出现在这里。</p>
                <button className="primary-action" onClick={() => { prepareForNewRecording(); switchTab("capture"); }}><AppIcon name="microphone" size={18} />开始哼唱</button>
              </section>
            )}
          </section>
        ) : null}

        {activeTab === "score" ? (
          <section className="screen score-screen">
            <div className="score-page-head">
              <div><span className="eyebrow">识别完成</span><h1>{melody.title || "未命名旋律"}</h1><p>{notes.length ? "点击音符可以修正。" : "请先录制或导入一段旋律。"}</p></div>
              <button className="edit-title" onClick={() => switchTab("library")}>我的创作</button>
            </div>
            {hasAudio ? <label className="project-name-field score-project-name-field"><span>作品名称</span><input value={melody.title} maxLength="40" onChange={(event) => updateProjectName(event.target.value)} onBlur={commitProjectName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder="未命名旋律" /></label> : null}
            {hasAudio ? <OriginalAudioPlayer url={voicePreviewUrl} fallbackDuration={sourceInfo.duration} label={sourceLabel(sourceInfo.kind)} /> : null}
            {notes.length ? <>
              {tunedPreviewUrl ? <section className="score-transcription-source" aria-label="曲谱转译版本">
                <div><strong>当前曲谱来源：{transcriptionSource === "tuned" ? "修音后人声" : "原声"}</strong><small>两个版本都经过 Basic Pitch 和人声音符整理。</small></div>
                <div className="score-transcription-actions">
                  <button className={transcriptionSource === "original" ? "active" : ""} onClick={() => restoreSavedTranscription("original")}>恢复原声结果</button>
                  <button className={transcriptionSource === "tuned" ? "active" : ""} onClick={() => restoreSavedTranscription("tuned")}>恢复修音版结果</button>
                </div>
              </section> : null}
              <div className="score-switch" aria-label="曲谱显示方式">
                <button className={currentView === "numbered" ? "active" : ""} onClick={() => setCurrentView("numbered")}>简谱</button>
                <button className={currentView === "staff" ? "active" : ""} onClick={() => setCurrentView("staff")}>五线谱</button>
              </div>
              <div className="score-meta">
                <span>{notes.length} 个音符</span>
                <span>{activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? "已应用整理节奏" : "保留自然节奏"}</span>
                {diagnosticsEnabled ? <><span>{activeRhythm.selectedTimeSignature || "4/4"}</span><span>{activeRhythm.selectedBpm || melody.tempo || "--"} BPM</span></> : null}
              </div>
              <label className="auto-tune-toggle">
                <input type="checkbox" checked={autoTuneEnabled} onChange={(event) => toggleGlobalAutoTune(event.target.checked)} />
                <span><strong>曲谱试听修正</strong><small>{autoTuneEnabled ? `已开启：乐器试听会贴近${autoTuneScale?.name || "旋律"}，尊重单音设置` : "已关闭：保留原始识别音高，单音设置会保留"}</small></span>
              </label>
              <div className={`score-paper ${currentView}`}>
                {currentView === "staff" ? <VexFlowScore notes={scoreNotes} rests={scoreRests} timeSignature={activeRhythm.selectedTimeSignature || "4/4"} selectedIndex={selectedNote} onSelect={openNoteEditor} /> : <NumberedScore notes={scoreNotes} rests={scoreRests} timeSignature={activeRhythm.selectedTimeSignature || "4/4"} selectedNote={selectedNote} playingIndex={playingIndex} onSelect={openNoteEditor} tonic={tonic} />}
                <p className="rhythm-note-text">{scoreRests.length ? "已按气口显示休止；曲谱和乐器试听读取同一份节奏。" : "当前保留自然节奏；需要时可在下方生成节奏整理预览。"}</p>
              </div>
              {diagnosticsEnabled ? <button className="diagnostics-copy-button" onClick={copyRecognitionTestResult}>复制测试结果</button> : null}
              <section className="rhythm-calibration rhythm-preview-panel" aria-label="节奏整理">
                <div className="rhythm-panel-head rhythm-summary-head">
                  <div>
                    <strong>{activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? "当前使用已应用的整理节奏" : "当前保留你的自然节奏"}</strong>
                    <span>{activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? "曲谱和乐器播放正在读取你确认过的整理结果。" : "长音、短音和气口都会按你原来的哼唱时间播放。"}</span>
                  </div>
                  <button className="secondary-action rhythm-preview-toggle" onClick={() => setShowRhythmPreview((visible) => !visible)}>{showRhythmPreview ? "收起节奏整理" : "让节奏更整齐"}</button>
                </div>
                {showRhythmPreview ? <>
                  <p className="rhythm-preview-status">当前正式使用：{activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? "整理后节奏" : "原节奏"}。整理结果只供试听，点击“应用这个节奏”后才会替换正式曲谱。</p>
                  <div className="rhythm-mode-options rhythm-mode-options-simple" role="group" aria-label="节奏整理方式">
                    {[
                      ["original", "保留原节奏", "恢复原来的快慢和停顿"],
                      ["light", "稍微整齐", "轻轻整理明显不齐的地方"],
                      ["standard", "更加整齐", "方便后续配伴奏"]
                    ].map(([value, label, description]) => <button key={value} className={rhythmPreviewMode === (value === "original" ? "original" : "quantized") && activeRhythm.quantizationMode === value ? "active" : ""} onClick={() => updateRhythmPreview({ quantizationMode: value })}><strong>{label}</strong><small>{description}</small></button>)}
                  </div>
                  {activeRhythm.quantizationDiagnostics?.blocked ? <p className="rhythm-preview-warning">这段旋律不太适合自动整理：预览的移动幅度、时值或气口变化过大，系统将继续使用原节奏。</p> : null}
                  {activeRhythm.quantizationDiagnostics?.bpmAmbiguous ? <p className="rhythm-preview-warning">检测到可能的半速或双速歧义，请分别试听后再决定是否应用。</p> : null}
                  <div className="rhythm-preview-actions">
                    <button className={rhythmPreviewPlaying === "original" ? "active" : ""} onClick={() => playRhythmPreview("original")}>试听原节奏</button>
                    <button className={rhythmPreviewPlaying === "quantized" ? "active" : ""} disabled={!activeRhythm.quantizedNotes?.length} onClick={() => playRhythmPreview("quantized")}>试听整理后</button>
                    <button className="primary-action" disabled={rhythmPreviewMode !== "quantized" || !activeRhythm.quantizedNotes?.length || activeRhythm.quantizationDiagnostics?.blocked} onClick={applyRhythmPreview}>应用这个节奏</button>
                  </div>
                  <div className="rhythm-secondary-actions">
                    <button onClick={() => activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? restoreOriginalRhythm() : updateRhythmPreview({ quantizationMode: "original" })}>保留原节奏</button>
                    {activeRhythm.rhythmSource === "quantized" && activeRhythm.quantizationEnabled ? <button onClick={restoreOriginalRhythm}>恢复原节奏</button> : null}
                    {diagnosticsEnabled ? <button onClick={copyRhythmJson}>复制节奏数据</button> : null}
                  </div>
                </> : null}
              </section>

              {lastEdit ? <button className="undo-button" onClick={undoLastEdit}>撤销上次修改</button> : null}
              <section className="instrument-player">
                <div><span className="eyebrow">乐器演奏</span><h2>选择一种乐器来播放旋律</h2></div>
                <div className="instrument-row">
                  {[["Piano", "钢琴"], ["Mallet", "木琴"]].map(([value, label]) => <button key={value} className={instrument === value ? "active" : ""} onClick={() => selectInstrument(value)}>{label}</button>)}
                </div>
                {instrumentLoadState.state === "loading" && instrumentLoadState.instrumentId === instrument ? <p className="instrument-load-state">正在加载{instrumentLabel}音色{instrumentLoadState.total ? " " + instrumentLoadState.loaded + "/" + instrumentLoadState.total : "…"}</p> : null}
                {instrumentLoadState.state === "ready" && instrumentLoadState.instrumentId === instrument ? <p className="instrument-load-state success">{instrumentLoadState.cached ? "已从浏览器缓存读取" : "真实采样音色已准备好"}{instrumentLoadState.transferBytes ? " · " + (instrumentLoadState.transferBytes / 1024 / 1024).toFixed(1) + " MB" : ""}</p> : null}
                {instrumentLoadState.state === "fallback" && instrumentLoadState.instrumentId === instrument ? <p className="instrument-load-state fallback">真实采样暂时不可用，已使用简化回退音色。</p> : null}
                <div className="playback-style" aria-label="演奏方式">
                  <span>演奏方式</span>
                  <button className={playbackStyle === "legato" ? "active" : ""} onClick={() => setPlaybackStyle("legato")}>连奏</button>
                  <button className={playbackStyle === "staccato" ? "active" : ""} onClick={() => setPlaybackStyle("staccato")}>清晰断奏</button>
                </div>
                <div className="melody-controls">
                  {playbackState === "playing" ? <button className="secondary-action" onClick={pauseMelody}>暂停</button> : <button className="primary-action" onClick={() => playMelody(playbackState === "paused" ? resumeIndex : 0)}>{playbackState === "paused" ? "继续播放" : "完整播放"}</button>}
                  <button className="secondary-action" onClick={() => playMelody(0)}>从头播放</button>
                </div>
                <p>{playbackState === "playing" ? `正在用${instrumentLabel}${playbackStyle === "legato" ? "连奏" : "断奏"}第 ${playingIndex + 1} 个音` : playbackStyle === "legato" ? "默认连奏，更接近人声旋律的自然衔接。" : "清晰断奏适合检查节奏和每个音的边界。"}</p>
              </section>
            </> : <div className="empty-score"><strong>还没有曲谱</strong><span>回到录音页，开始哼唱或导入录音。</span><button className="primary-action" onClick={() => setActiveTab("capture")}>去录音</button></div>}
            <p className="screen-feedback" role="status">{statusMessage}</p>
          </section>
        ) : null}

        {activeTab === "arrange" ? (
          <section className="screen arrangement-preview-screen">
            <div className="arrangement-preview-head">
              <span className="eyebrow">未来创作工具</span>
              <h1>AI 编曲<small>让一段哼唱，慢慢长成一首歌</small></h1>
              <p>未来你可以保留自己的主旋律，并让 AI 帮你选择音乐风格、加入乐器和生成完整伴奏。</p>
            </div>

            <section className="arrangement-visual" aria-label="从哼唱到完整歌曲的未来编曲流程示意">
              <div className="arrangement-visual-topline"><strong>从哼唱到完整歌曲</strong><span>即将上线</span></div>
              <p>保留你的旋律，再为它加入和弦、节奏和伴奏。</p>
              <div className="arrangement-track-list" aria-hidden="true">
                <div className="arrangement-track humming-track">
                  <div className="track-label"><span>01</span><strong>你的哼唱</strong></div>
                  <div className="track-lane melody-lane"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
                </div>
                <div className="arrangement-track chord-track">
                  <div className="track-label"><span>02</span><strong>加入和弦</strong></div>
                  <div className="track-lane chord-lane"><i /><i /><i /><i /></div>
                </div>
                <div className="arrangement-track rhythm-track">
                  <div className="track-label"><span>03</span><strong>加入节奏</strong></div>
                  <div className="track-lane rhythm-lane"><i /><i /><i /><i /><i /><i /><i /><i /></div>
                </div>
                <div className="arrangement-track full-track">
                  <div className="track-label"><span>04</span><strong>完整伴奏</strong></div>
                  <div className="track-lane full-lane"><b /><b /><b /></div>
                </div>
              </div>
            </section>

            <section className="arrangement-future-grid" aria-label="AI 编曲未来能力预览">
              <article><span className="future-tag">即将上线</span><strong>选择风格</strong><p>流行、民谣、电子、电影感</p></article>
              <article><span className="future-tag">即将上线</span><strong>选择声音</strong><p>钢琴、吉他、弦乐、鼓和贝斯</p></article>
              <article><span className="future-tag">即将上线</span><strong>生成多个版本</strong><p>简单伴奏、完整编曲、氛围版本</p></article>
            </section>

            <section className="arrangement-status-card">
              <div><span className="eyebrow">创作持续生长</span><strong>AI 编曲正在准备中</strong><p>当前版本可以先完成录音、曲谱识别和旋律修正。</p></div>
              <button className="primary-action arrangement-back-button" onClick={() => switchTab("score")}><AppIcon name="score" size={18} />返回曲谱</button>
            </section>
          </section>
        ) : null}
      </main>

      <nav className="bottom-navigation" aria-label="主导航">
        {[["capture", "recording", "录制"], ["library", "score", "创作"], ["arrange", "sparkle", "AI 编曲"]].map(([tab, icon, label]) => <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => switchTab(tab)}><span><AppIcon name={icon} size={19} /></span>{label}</button>)}
      </nav>

      {selectedNoteData ? <>
        <button className="sheet-backdrop" aria-label="关闭音符编辑" onClick={() => closeNoteEditor(true)} />
        <section
          className="note-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="修正音符"
          onTouchStart={(event) => {
            sheetTouchStartRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(event) => {
            const startY = sheetTouchStartRef.current;
            const endY = event.changedTouches[0]?.clientY;
            if (startY !== null && endY && endY - startY > 90) closeNoteEditor(true);
            sheetTouchStartRef.current = null;
          }}
        >
          <div className="sheet-handle" />
          <button className="sheet-close" onClick={() => closeNoteEditor(true)} aria-label="关闭">×</button>
          <span className="eyebrow">修正第 {selectedNote + 1} 个音</span>
          <h2>{selectedNoteData.solfege} <small>{midiToPitchName(selectedNoteData.midi)}</small></h2>
          <p>这是一个{selectedNoteData.duration}音符。调高或调低后，可以立刻试听。</p>
          <div className="pitch-adjust"><button onClick={() => updateSelectedPitch(-1)}>− 降低半音</button><button onClick={() => updateSelectedPitch(1)}>+ 升高半音</button></div>
          <div className="manual-pitch">
            <label htmlFor="manualPitch">手动输入音高</label>
            <div><input id="manualPitch" value={manualPitchInput} onChange={(event) => setManualPitchInput(event.target.value)} placeholder="例如 C4、F#4 或 Bb3" /><button onClick={applyManualPitch}>应用</button></div>
          </div>
          <div className="rhythm-note-editor">
            <span>节奏微调</span>
            <div><button onClick={() => adjustSelectedRhythm("start", -1)}>提前</button><button onClick={() => adjustSelectedRhythm("start", 1)}>延后</button><button onClick={() => adjustSelectedRhythm("duration", -1)}>缩短</button><button onClick={() => adjustSelectedRhythm("duration", 1)}>延长</button></div>
          </div>
          <label className="auto-tune-toggle note-auto-tune">
            <input type="checkbox" checked={Boolean(selectedNoteData.autoTune)} onChange={(event) => toggleSelectedAutoTune(event.target.checked)} />
            <span><strong>对这个音应用试听修正</strong><small>{autoTuneEnabled ? "关闭后，乐器试听保留它的手动或原始识别音高" : "总开关目前关闭；下次开启时会采用这里的选择"}</small></span>
          </label>
          {canMergePrevious || canMergeNext ? <div className="merge-actions">
            <span>相邻音高相同，可以合并成一个持续音</span>
            {canMergePrevious ? <button className="secondary-action" onClick={() => mergeWithNeighbor(-1)}>与前一个合并</button> : null}
            {canMergeNext ? <button className="secondary-action" onClick={() => mergeWithNeighbor(1)}>与后一个合并</button> : null}
          </div> : null}
          <div className="phrase-actions">
            <span>乐句与气口</span>
            <button className="secondary-action" onClick={splitSelectedNote}>从这里拆成两个音</button>
            {selectedNote < notes.length - 1 ? <button className="secondary-action" onClick={toggleBreathAfterSelected}>{selectedNoteData.hasBreathAfter ? "删除后方气口" : "在后方添加气口"}</button> : null}
          </div>
          <div className="sheet-actions"><button className="secondary-action" onClick={restoreOriginalNote}>恢复原始识别</button><button className="secondary-action" onClick={previewSelectedNote}>单音试听</button></div>
          <button className="primary-action" onClick={confirmNoteEdit}>确认修改</button>
        </section>
      </> : null}
      <div className={`toast${toastVisible ? " show" : ""}`}>{toastMessage}</div>
    </div>
  );
}

export default ProductApp;
