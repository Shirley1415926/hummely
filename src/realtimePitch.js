import { PitchDetector } from "pitchy";

const DEFAULT_OPTIONS = {
  minFrequency: 80,
  maxFrequency: 1050,
  minRms: 0.002,
  minVoicedRms: 0.0006,
  voiceToNoiseRatio: 2.2,
  noiseFloorSmoothing: 0.16,
  silenceConfirmSeconds: 0.75,
  minClarity: 0.62,
  stableFrames: 2,
  historySize: 5,
  midiTolerance: 1
};

function rms(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] ** 2;
  return Math.sqrt(total / Math.max(1, samples.length));
}

function frequencyToMidi(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

// Separates human-voice presence from reliable F0. A held vowel is still
// visibly voiced when a few pitch frames are unclear.
export function createLivePitchDisplayState({ silenceConfirmSeconds = 0.75 } = {}) {
  let displayedPitch = null;
  let silenceSeconds = 0;

  function reset() {
    displayedPitch = null;
    silenceSeconds = 0;
  }

  return {
    update({ voiced, pitch = null, durationSeconds = 0 }) {
      if (!voiced) {
        silenceSeconds += Math.max(0, durationSeconds);
        if (silenceSeconds >= silenceConfirmSeconds) displayedPitch = null;
      } else {
        silenceSeconds = 0;
        if (pitch) displayedPitch = { ...pitch };
      }
      if (!displayedPitch) return null;
      return {
        ...displayedPitch,
        voiced: Boolean(voiced),
        pitchReliable: Boolean(pitch),
        held: !pitch,
        silenceSeconds
      };
    },
    getDisplayedPitch() {
      return displayedPitch ? { ...displayedPitch } : null;
    },
    reset
  };
}

// This tracker only powers the live recording label. It never changes saved
// notes. A noise-adaptive voice gate decides silence; pitch failures merely hold
// the last stable label while audio remains voiced.
export function createRealtimePitchTracker(inputLength, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const detector = PitchDetector.forFloat32Array(inputLength);
  const displayState = createLivePitchDisplayState(config);
  let candidateMidi = null;
  let candidateCount = 0;
  let displayedFrequency = 0;
  let frequencies = [];
  let noiseFloor = config.minVoicedRms;

  function resetPitchCandidate() {
    candidateMidi = null;
    candidateCount = 0;
    displayedFrequency = 0;
    frequencies = [];
  }

  function reset() {
    resetPitchCandidate();
    noiseFloor = config.minVoicedRms;
    displayState.reset();
  }

  return {
    detect(samples, sampleRate) {
      const volume = rms(samples);
      const durationSeconds = samples.length / Math.max(1, sampleRate);
      const voiceGate = Math.max(config.minVoicedRms, noiseFloor * config.voiceToNoiseRatio);
      const voiced = volume >= voiceGate;
      if (!voiced) {
        noiseFloor = noiseFloor * (1 - config.noiseFloorSmoothing) + volume * config.noiseFloorSmoothing;
        const result = displayState.update({ voiced: false, durationSeconds });
        if (!result) resetPitchCandidate();
        return result;
      }

      const [frequency, clarity] = detector.findPitch(samples, sampleRate);
      const pitchReliable = volume >= config.minRms && Number.isFinite(frequency) && Number.isFinite(clarity) &&
        frequency >= config.minFrequency && frequency <= config.maxFrequency && clarity >= config.minClarity;
      if (!pitchReliable) {
        return displayState.update({ voiced: true, durationSeconds });
      }

      frequencies = [...frequencies.slice(-(config.historySize - 1)), frequency];
      const smoothedFrequency = median(frequencies);
      const observedMidi = frequencyToMidi(smoothedFrequency);
      const displayed = displayState.getDisplayedPitch();
      const nearDisplayedPitch = displayed !== null && Math.abs(observedMidi - displayed.midi) <= config.midiTolerance;

      if (nearDisplayedPitch) {
        candidateMidi = displayed.midi;
        candidateCount = config.stableFrames;
        displayedFrequency = smoothedFrequency;
      } else if (observedMidi === candidateMidi) {
        candidateCount += 1;
      } else {
        candidateMidi = observedMidi;
        candidateCount = 1;
      }

      const stablePitch = candidateCount >= config.stableFrames
        ? { frequency: displayedFrequency || smoothedFrequency, midi: nearDisplayedPitch ? displayed.midi : candidateMidi, clarity, rms: volume }
        : null;
      return displayState.update({ voiced: true, pitch: stablePitch, durationSeconds });
    },
    reset
  };
}
