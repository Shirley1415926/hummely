import { PitchDetector } from "pitchy";
import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import soundTouchProcessorUrl from "@soundtouchjs/audio-worklet/processor?url";

export const VOCAL_TUNING_VERSION = "soundtouchjs-audioworklet@2.1.1+hummely-v1";

const TUNING_PRESETS = {
  natural: { label: "自然", strength: 0.52, rampSeconds: 0.095, maxShiftSemitones: 1.35 },
  strong: { label: "明显", strength: 0.92, rampSeconds: 0.045, maxShiftSemitones: 2.2 }
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rms(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] ** 2;
  return Math.sqrt(total / Math.max(1, samples.length));
}

function mixToMono(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length);
  const channels = Math.max(1, audioBuffer.numberOfChannels);
  for (let channel = 0; channel < channels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / channels;
  }
  return mono;
}

function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new DOMException("已取消生成修音预览。", "AbortError");
}

/**
 * Detect a conservative monophonic vocal pitch track. This is independent of
 * Basic Pitch: it only determines the time-varying audio effect control curve.
 */
export function analyzeVocalPitchTrack(audioBuffer, options = {}) {
  const windowSize = options.windowSize || 2048;
  const hopSize = options.hopSize || 1024;
  const minRms = options.minRms || 0.006;
  const minClarity = options.minClarity || 0.66;
  const mono = mixToMono(audioBuffer);
  const detector = PitchDetector.forFloat32Array(windowSize);
  const frames = [];
  for (let start = 0; start + windowSize <= mono.length; start += hopSize) {
    const samples = mono.subarray(start, start + windowSize);
    const level = rms(samples);
    const startTime = start / audioBuffer.sampleRate;
    const endTime = (start + windowSize) / audioBuffer.sampleRate;
    if (level < minRms) {
      frames.push({ startTime, endTime, voiced: false, rms: level });
      continue;
    }
    const [frequency, clarity] = detector.findPitch(samples, audioBuffer.sampleRate);
    if (!Number.isFinite(frequency) || !Number.isFinite(clarity) || frequency < 75 || frequency > 1050 || clarity < minClarity) {
      frames.push({ startTime, endTime, voiced: false, rms: level, clarity: clarity || 0 });
      continue;
    }
    frames.push({ startTime, endTime, voiced: true, rms: level, clarity, frequency, midi: frequencyToMidi(frequency) });
  }
  return frames;
}

/**
 * Creates stable chromatic correction segments. Target changes require a small
 * stable region, preventing adjacent semitones from flickering on natural vibrato.
 */
export function createVocalCorrectionTimeline(frames, strength = "natural") {
  const preset = TUNING_PRESETS[strength] || TUNING_PRESETS.natural;
  const prepared = frames.map((frame, index) => {
    if (!frame.voiced) return { ...frame, shiftSemitones: 0, targetMidi: null };
    const neighbourhood = frames
      .slice(Math.max(0, index - 2), Math.min(frames.length, index + 3))
      .filter((candidate) => candidate.voiced && Math.abs(candidate.startTime - frame.startTime) < 0.09)
      .map((candidate) => candidate.midi);
    const stableMidi = median(neighbourhood.length ? neighbourhood : [frame.midi]);
    const targetMidi = Math.round(stableMidi);
    const rawShift = targetMidi - stableMidi;
    return {
      ...frame,
      stableMidi,
      targetMidi,
      shiftSemitones: clamp(rawShift * preset.strength, -preset.maxShiftSemitones, preset.maxShiftSemitones)
    };
  });

  const segments = [];
  prepared.forEach((frame) => {
    if (!frame.voiced) return;
    const previous = segments[segments.length - 1];
    const contiguous = previous && frame.startTime - previous.endTime <= 0.055;
    if (previous && contiguous && previous.targetMidi === frame.targetMidi) {
      previous.endTime = frame.endTime;
      previous.shifts.push(frame.shiftSemitones);
      previous.rms.push(frame.rms);
      return;
    }
    segments.push({
      startTime: frame.startTime,
      endTime: frame.endTime,
      targetMidi: frame.targetMidi,
      shifts: [frame.shiftSemitones],
      rms: [frame.rms]
    });
  });

  return segments
    .filter((segment) => segment.endTime - segment.startTime >= 0.07)
    .map((segment) => ({
      ...segment,
      shiftSemitones: median(segment.shifts),
      averageRms: segment.rms.reduce((total, value) => total + value, 0) / segment.rms.length,
      shifts: undefined,
      rms: undefined
    }));
}

function writeString(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

// WAV is chosen for the generated preview because Safari can play it directly
// and a Blob needs no server-side encoder or uploaded audio.
export function audioBufferToWavBlob(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(audioBuffer.getChannelData(channel)[frame], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function renderWithAutomatedPitch(input, timeline, signal) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext || !window.AudioWorkletNode) {
    throw new Error("当前浏览器不支持本地修音预览。请使用最新版 Safari 或 Chrome，仍可使用原声转译。");
  }
  const context = new OfflineContext(input.numberOfChannels, input.length, input.sampleRate);
  assertNotCancelled(signal);
  await SoundTouchNode.register(context, soundTouchProcessorUrl);
  assertNotCancelled(signal);
  const source = context.createBufferSource();
  source.buffer = input;
  const soundTouch = new SoundTouchNode({ context });
  soundTouch.pitchSemitones.setValueAtTime(0, 0);
  const rampSeconds = 0.06;
  let lastTime = 0;
  timeline.forEach((segment) => {
    const startTime = Math.max(lastTime, segment.startTime);
    const fadeInEnd = Math.min(segment.endTime, startTime + rampSeconds);
    soundTouch.pitchSemitones.setValueAtTime(0, Math.max(0, startTime - 0.012));
    soundTouch.pitchSemitones.linearRampToValueAtTime(segment.shiftSemitones, fadeInEnd);
    soundTouch.pitchSemitones.setValueAtTime(segment.shiftSemitones, Math.max(fadeInEnd, segment.endTime - rampSeconds));
    soundTouch.pitchSemitones.linearRampToValueAtTime(0, segment.endTime);
    lastTime = segment.endTime;
  });
  source.connect(soundTouch);
  soundTouch.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  assertNotCancelled(signal);
  return rendered;
}

export async function createTunedVocalPreview(blob, decodingContext, options = {}) {
  const { strength = "natural", onProgress = () => {}, signal } = options;
  assertNotCancelled(signal);
  onProgress({ stage: "decoding", message: "正在读取原声…" });
  const decoded = await decodingContext.decodeAudioData((await blob.arrayBuffer()).slice(0));
  assertNotCancelled(signal);
  onProgress({ stage: "analyzing", message: "正在分析人声音高…" });
  const frames = analyzeVocalPitchTrack(decoded);
  const timeline = createVocalCorrectionTimeline(frames, strength);
  assertNotCancelled(signal);
  onProgress({ stage: "rendering", message: "正在生成可试听的修音人声…" });
  const rendered = await renderWithAutomatedPitch(decoded, timeline, signal);
  assertNotCancelled(signal);
  const tunedBlob = audioBufferToWavBlob(rendered);
  return {
    blob: tunedBlob,
    diagnostics: {
      tuningVersion: VOCAL_TUNING_VERSION,
      tuningMode: "free-chromatic",
      tuningStrength: strength,
      originalDuration: decoded.duration,
      tunedDuration: rendered.duration,
      analyzedFrameCount: frames.length,
      voicedFrameCount: frames.filter((frame) => frame.voiced).length,
      correctionSegmentCount: timeline.length,
      correctionSegments: timeline.map((segment) => ({
        startTime: Number(segment.startTime.toFixed(3)),
        endTime: Number(segment.endTime.toFixed(3)),
        targetMidi: segment.targetMidi,
        shiftSemitones: Number(segment.shiftSemitones.toFixed(3))
      }))
    }
  };
}

export function getTuningPreset(strength) {
  return TUNING_PRESETS[strength] || TUNING_PRESETS.natural;
}
