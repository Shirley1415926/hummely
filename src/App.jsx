import { useEffect, useRef, useState } from "react";

const durationOptions = [
  { label: "八分", beats: 0.5 },
  { label: "四分", beats: 1 },
  { label: "二分", beats: 2 },
  { label: "全音", beats: 4 }
];

const arrangementAdvice = {
  "piano-ballad":
    "当前建议：先录一段尽量单线条、没有太多滑音的旋律，钢琴版最适合先检查音准和节奏。",
  "folk-pop":
    "当前建议：如果你的旋律更偏口语化，可以切到木吉他试听，主副歌的强弱会更容易听出来。",
  cinematic:
    "当前建议：如果结尾有长音，试着保留更长的时值，再用小提琴或长笛试听，会更有空间感。"
};

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

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
  return option ? option.label : "四分";
}

function createNote(midi, beats, beatUnitSeconds, rawSeconds = beats * beatUnitSeconds) {
  const pitchMeta = getPitchMeta(midi);
  return {
    midi: Math.round(midi),
    beats,
    duration: durationLabelFromBeats(beats),
    noteSeconds: rawSeconds,
    pitchIndex: clamp(Math.round(midi) - 55, 0, 26),
    jianpu: pitchMeta.jianpu,
    solfege: pitchMeta.solfege
  };
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

function autoCorrelate(buffer, sampleRate) {
  let rms = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    rms += buffer[index] * buffer[index];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.006) {
    return { frequency: null, clarity: 0, rms };
  }

  let start = 0;
  let end = buffer.length - 1;
  const edgeThreshold = 0.2;

  while (start < buffer.length / 2 && Math.abs(buffer[start]) < edgeThreshold) {
    start += 1;
  }
  while (end > buffer.length / 2 && Math.abs(buffer[end]) < edgeThreshold) {
    end -= 1;
  }

  const trimmed = buffer.slice(start, end + 1);
  const size = trimmed.length;
  if (size < 32) {
    return { frequency: null, clarity: 0, rms };
  }

  const correlations = new Array(size).fill(0);
  for (let offset = 0; offset < size; offset += 1) {
    for (let index = 0; index < size - offset; index += 1) {
      correlations[offset] += trimmed[index] * trimmed[index + offset];
    }
  }

  let dip = 0;
  while (dip < size - 1 && correlations[dip] > correlations[dip + 1]) {
    dip += 1;
  }

  let bestOffset = -1;
  let bestCorrelation = -Infinity;
  const minOffset = Math.floor(sampleRate / 1200);
  const maxOffset = Math.min(size - 1, Math.floor(sampleRate / 70));

  for (let offset = Math.max(dip, minOffset); offset <= maxOffset; offset += 1) {
    if (correlations[offset] > bestCorrelation) {
      bestCorrelation = correlations[offset];
      bestOffset = offset;
    }
  }

  if (bestOffset <= 0) {
    return { frequency: null, clarity: 0, rms };
  }

  if (bestOffset > 0 && bestOffset < size - 1) {
    const x1 = correlations[bestOffset - 1];
    const x2 = correlations[bestOffset];
    const x3 = correlations[bestOffset + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) {
      bestOffset -= b / (2 * a);
    }
  }

  const clarity = correlations[0] ? bestCorrelation / correlations[0] : 0;
  const frequency = sampleRate / bestOffset;

  if (!Number.isFinite(frequency) || frequency < 70 || frequency > 1200 || clarity < 0.02) {
    return { frequency: null, clarity, rms };
  }

  return {
    frequency,
    clarity,
    rms
  };
}

function quantizeSecondsToBeats(seconds, beatUnitSeconds) {
  const candidates = durationOptions.map((option) => ({
    ...option,
    delta: Math.abs(seconds - option.beats * beatUnitSeconds)
  }));
  candidates.sort((left, right) => left.delta - right.delta);
  return candidates[0];
}

function extractPlayableFrames(frames) {
  const thresholdProfiles = [
    { clarity: 0.16, rms: 0.012 },
    { clarity: 0.12, rms: 0.008 },
    { clarity: 0.08, rms: 0.005 }
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

    if (candidates.length >= 4) {
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
      grouped.push({ midiValues: [frame.midi], duration: 0.16 });
      return;
    }

    if (Math.abs(median(previous.midiValues) - frame.midi) <= 2) {
      previous.midiValues.push(frame.midi);
      previous.duration += 0.12;
    } else {
      grouped.push({ midiValues: [frame.midi], duration: 0.18 });
    }
  });

  const beatUnitSeconds = clamp(median(grouped.map((item) => item.duration)) || 0.5, 0.35, 0.9);
  const notes = grouped.slice(0, 12).map((group) => {
    const midi = Math.round(median(group.midiValues));
    const quantized = quantizeSecondsToBeats(group.duration, beatUnitSeconds);
    return createNote(midi, quantized.beats, beatUnitSeconds, group.duration);
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
  const windowSize = 2048;
  const hopSize = 512;

  for (let offset = 0; offset + windowSize < channelData.length; offset += hopSize) {
    const slice = channelData.slice(offset, offset + windowSize);
    const analysis = autoCorrelate(slice, decoded.sampleRate);
    frames.push({
      time: offset / decoded.sampleRate,
      frequency: analysis.frequency,
      clarity: analysis.clarity,
      rms: analysis.rms
    });
  }

  return frames;
}

function buildMelodyFromFrames(frames, title) {
  if (!frames.length) {
    return null;
  }

  const filteredFrames = extractPlayableFrames(frames);

  if (filteredFrames.length < 4) {
    return createFallbackMelody(frames, title);
  }

  const smoothedFrames = filteredFrames.map((frame, index) => {
    const neighbours = filteredFrames
      .slice(Math.max(0, index - 2), Math.min(filteredFrames.length, index + 3))
      .map((item) => item.midiRaw);

    return {
      ...frame,
      midi: Math.round(median(neighbours))
    };
  });

  const segments = [];
  let current = null;

  smoothedFrames.forEach((frame, index) => {
    const previousFrame = smoothedFrames[index - 1];
    const deltaTime = previousFrame ? frame.time - previousFrame.time : 0.05;

    if (!current) {
      current = {
        midiValues: [frame.midi],
        lastTime: frame.time,
        duration: Math.max(deltaTime, 0.05)
      };
      return;
    }

    const closeInPitch = Math.abs(frame.midi - median(current.midiValues)) <= 1;
    const closeInTime = frame.time - current.lastTime <= 0.2;

    if (closeInPitch && closeInTime) {
      current.midiValues.push(frame.midi);
      current.lastTime = frame.time;
      current.duration += Math.max(deltaTime, 0.05);
    } else {
      segments.push(current);
      current = {
        midiValues: [frame.midi],
        lastTime: frame.time,
        duration: Math.max(deltaTime, 0.05)
      };
    }
  });

  if (current) {
    segments.push(current);
  }

  const mergedSegments = [];
  segments.forEach((segment) => {
    const midi = Math.round(median(segment.midiValues));
    const normalized = { midi, duration: segment.duration };

    if (!mergedSegments.length) {
      mergedSegments.push(normalized);
      return;
    }

    const previous = mergedSegments[mergedSegments.length - 1];
    const shortDuration = normalized.duration < 0.14;
    const closePitch = Math.abs(previous.midi - normalized.midi) <= 1;

    if (shortDuration || closePitch) {
      previous.duration += normalized.duration;
      previous.midi = Math.round((previous.midi + normalized.midi) / 2);
    } else {
      mergedSegments.push(normalized);
    }
  });

  const noteDurations = mergedSegments.map((segment) => segment.duration).filter((duration) => duration > 0.16);
  const beatUnitSeconds = clamp(median(noteDurations) || 0.55, 0.3, 0.95);
  const notes = mergedSegments
    .filter((segment) => segment.duration >= 0.12)
    .map((segment) => {
      const quantized = quantizeSecondsToBeats(segment.duration, beatUnitSeconds);
      return createNote(segment.midi, quantized.beats, beatUnitSeconds, segment.duration);
    });

  if (!notes.length) {
    return createFallbackMelody(frames, title);
  }

  const confidence = Math.round(
    clamp(
      (filteredFrames.length / frames.length) * 68 + Math.min(30, notes.length * 3),
      52,
      97
    )
  );
  const tempo = Math.round(60 / beatUnitSeconds);

  return {
    title,
    analysis: `真实录音转译 · 识别置信度 ${confidence}% · ${notes.length} 个音符 · 估算速度 ${tempo} BPM`,
    beatUnitSeconds,
    confidence,
    tempo,
    notes
  };
}

function makeVoiceEnvelope(context, when, attack, hold, release, peak) {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + attack);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.58, 0.08), when + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
  gain.connect(context.destination);
  return gain;
}

function buildInstrumentVoice(context, instrument, frequency, when, duration) {
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
    }
  };

  const recipe = envelopeMap[instrument] || envelopeMap.Piano;
  const gain = makeVoiceEnvelope(context, when, recipe.attack, recipe.hold, recipe.release, recipe.peak);
  const filter = context.createBiquadFilter();
  filter.type = instrument === "Flute" ? "lowpass" : "bandpass";
  filter.frequency.setValueAtTime(
    instrument === "Violin" ? 2100 : instrument === "Flute" ? 2600 : 1800,
    when
  );
  filter.Q.setValueAtTime(instrument === "Guitar" ? 1.5 : 0.8, when);
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
    oscillator.stop(when + recipe.attack + recipe.hold + recipe.release + 0.05);
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
    lfo.stop(when + recipe.attack + recipe.hold + recipe.release + 0.05);
  }

  return { gain, oscillators, lfo };
}

const initialAudioState = () => ({
  audioContext: null,
  mediaStream: null,
  mediaRecorder: null,
  mediaSource: null,
  processorNode: null,
  silenceGain: null,
  recordStartTime: 0,
  pitchFrames: [],
  stableFrameCount: 0,
  lastCapturedFrames: [],
  recordedChunks: [],
  recordedBlob: null,
  recordedUrl: "",
  playTimeouts: [],
  activeVoices: []
});

export default function App() {
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
    if (!audioRef.current.audioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      audioRef.current.audioContext = new Context();
    }
    if (audioRef.current.audioContext.state === "suspended") {
      await audioRef.current.audioContext.resume();
    }
    return audioRef.current.audioContext;
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
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
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
        const analysis = autoCorrelate(sample, context.sampleRate);
        const time = (performance.now() - audioState.recordStartTime) / 1000;
        audioState.pitchFrames.push({
          time,
          frequency: analysis.frequency,
          clarity: analysis.clarity,
          rms: analysis.rms
        });

        if (analysis.frequency && analysis.clarity > 0.16 && analysis.rms > 0.012) {
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
    let transcribedMelody = buildMelodyFromFrames(targetFrames, title);

    if (!transcribedMelody && audioState.recordedBlob) {
      try {
        const context = await ensureAudioContext();
        const offlineFrames = await extractFramesFromBlob(audioState.recordedBlob, context);
        transcribedMelody = buildMelodyFromFrames(offlineFrames, title);
        if (transcribedMelody) {
          setStatusMessage(
            `转译完成：识别出 ${transcribedMelody.notes.length} 个音符。这次使用了整段录音的离线分析，所以结果会比实时识别更稳。`
          );
        }
      } catch (error) {
        setStatusMessage(`离线分析录音失败：${error.message || "请再录一遍试试"}`);
      }
    }

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
    if (!transcribedMelody.analysis.includes("离线分析")) {
      setStatusMessage(`转译完成：识别出 ${transcribedMelody.notes.length} 个音符。现在可以直接切乐器试听，也可以逐个修音。`);
    }
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
              <p>把脑海里的旋律，变成可编辑、可演奏、可继续创作的曲谱。</p>
            </div>
          </div>
          <div className="top-actions">
            <div className="pill">Installable PWA</div>
            <div className="pill">Single Melody</div>
            <div className="pill">{isStandalone ? "App Mode" : "Web + App"}</div>
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

        <section className="studio">
          <aside className="panel">
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

          <main className="panel center-panel">
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
                          onClick={() => setSelectedNote(index)}
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

          <aside className="panel">
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
