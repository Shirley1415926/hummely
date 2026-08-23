// Rhythm defaults are kept outside React so recordings and restored projects use one contract.
export const RHYTHM_ENGINE_VERSION = "hummely-rhythm-v1";

export const METRONOME_SPEEDS = {
  slow: { label: "慢", bpm: 60 },
  medium: { label: "中", bpm: 80 },
  fast: { label: "快", bpm: 100 }
};

// Three deliberately soft Web Audio click recipes. The default is warmWood:
// a low, short double-sine knock with no high-frequency alert tone.
export const METRONOME_SOUND_PRESETS = {
  warmWood: {
    label: "柔和木质敲击",
    frequencies: [460, 690],
    harmonics: [1, 0.18],
    filterHz: 1180,
    attackSeconds: 0.004,
    decaySeconds: 0.058,
    downbeatGain: 1.12
  },
  softTap: {
    label: "轻敲",
    frequencies: [400, 610],
    harmonics: [1, 0.12],
    filterHz: 1050,
    attackSeconds: 0.005,
    decaySeconds: 0.05,
    downbeatGain: 1.08
  },
  roundPulse: {
    label: "圆润短音",
    frequencies: [360, 540],
    harmonics: [1, 0.1],
    filterHz: 930,
    attackSeconds: 0.006,
    decaySeconds: 0.064,
    downbeatGain: 1.1
  }
};

export const TIME_SIGNATURES = {
  "4/4": { value: "4/4", label: "四拍子", description: "最常见，每小节 4 拍", numerator: 4, denominator: 4 },
  "3/4": { value: "3/4", label: "三拍子", description: "圆舞曲感觉，每小节 3 拍", numerator: 3, denominator: 4 },
  "6/8": { value: "6/8", label: "六八拍", description: "摇摆流动感，每小节 6 个八分拍", numerator: 6, denominator: 8 }
};

export const QUANTIZATION_MODES = {
  original: { label: "保留原节奏", strength: 0, description: "不改变你的自然节奏" },
  light: { label: "轻度整理", strength: 0.34, description: "只修正明显偏离" },
  standard: { label: "标准整理", strength: 0.72, description: "大部分音符靠近合理拍点" },
  strong: { label: "强力规整", strength: 1, description: "更适合规则伴奏" }
};

export const QUANTIZATION_GRIDS = {
  quarter: { label: "简单", description: "最小四分音符", beats: 1 },
  eighth: { label: "标准", description: "最小八分音符", beats: 0.5 },
  sixteenth: { label: "精细", description: "最小十六分音符", beats: 0.25 }
};

export const DEFAULT_METRONOME_SETTINGS = {
  enabled: false,
  speed: "medium",
  bpm: 80,
  timeSignature: "4/4",
  countInMeasures: 0,
  cueMode: { audio: false, visual: true, vibrate: false },
  soundPreset: "warmWood",
  volume: 0.13
};

export const DEFAULT_RHYTHM_SETTINGS = {
  selectedBpm: 80,
  bpmSource: "detected",
  selectedTimeSignature: "4/4",
  quantizationEnabled: false,
  quantizationMode: "original",
  quantizationGrid: "eighth",
  rhythmSource: "original"
};

export function getTimeSignature(value) {
  return TIME_SIGNATURES[value] || TIME_SIGNATURES["4/4"];
}

export function getMeasureBeats(timeSignature) {
  const signature = getTimeSignature(timeSignature);
  return signature.numerator * (4 / signature.denominator);
}
