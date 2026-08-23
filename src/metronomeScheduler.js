import { getTimeSignature, METRONOME_SOUND_PRESETS } from "./rhythmConfig.js";

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.13;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Web Audio's clock is the source of truth. The interval merely wakes up early
// enough to schedule future clicks and visual cues against that clock.
export class MetronomeScheduler {
  constructor(context, options) {
    this.context = context;
    this.options = options;
    this.timer = null;
    this.timeoutIds = [];
    this.activeNodes = [];
    this.nextBeatTime = 0;
    this.startTime = 0;
    this.beatIndex = 0;
    this.running = false;
    this.diagnostics = [];
  }

  start({ startTime = this.context.currentTime + 0.08, onBeat }) {
    this.stop();
    this.startTime = startTime;
    this.nextBeatTime = startTime;
    this.beatIndex = 0;
    this.running = true;
    this.onBeat = onBeat;
    this.schedulerTick();
    this.timer = window.setInterval(() => this.schedulerTick(), LOOKAHEAD_MS);
    return startTime;
  }

  schedulerTick() {
    if (!this.running || this.context.state === "closed") return;
    while (this.nextBeatTime < this.context.currentTime + SCHEDULE_AHEAD_SECONDS) {
      this.scheduleBeat(this.nextBeatTime, this.beatIndex);
      this.beatIndex += 1;
      // Derive from the original audio-clock start, never from repeated float accumulation.
      this.nextBeatTime = this.startTime + this.beatIndex * this.secondsPerBeat();
    }
  }

  secondsPerBeat() {
    return 60 / clamp(Number(this.options.bpm) || 80, 40, 200) * (4 / getTimeSignature(this.options.timeSignature).denominator);
  }

  scheduleBeat(scheduledBeatTime, beatIndex) {
    const signature = getTimeSignature(this.options.timeSignature);
    const beatInMeasure = beatIndex % signature.numerator;
    const isDownbeat = beatInMeasure === 0;
    const measureIndex = Math.floor(beatIndex / signature.numerator);
    const details = {
      scheduledBeatTime,
      actualBeatTime: null,
      driftMs: null,
      beatIndex,
      measureIndex,
      beatInMeasure: beatInMeasure + 1,
      isDownbeat
    };
    this.diagnostics.push(details);
    if (this.diagnostics.length > 512) this.diagnostics.shift();

    if (this.options.cueMode?.audio) this.scheduleClick(scheduledBeatTime, isDownbeat);
    const delay = Math.max(0, (scheduledBeatTime - this.context.currentTime) * 1000);
    const timeoutId = window.setTimeout(() => {
      if (!this.running) return;
      const actualBeatTime = this.context.currentTime;
      details.actualBeatTime = actualBeatTime;
      details.driftMs = Math.round((actualBeatTime - scheduledBeatTime) * 1000 * 100) / 100;
      if (this.options.cueMode?.vibrate && typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(isDownbeat ? 22 : 12);
        } catch {
          // Safari currently ignores Vibration API; a visual pulse remains available.
        }
      }
      this.onBeat?.(details);
    }, delay);
    this.timeoutIds.push(timeoutId);
  }

  scheduleClick(when, isDownbeat) {
    const preset = METRONOME_SOUND_PRESETS[this.options.soundPreset] || METRONOME_SOUND_PRESETS.warmWood;
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    const peak = clamp(Number(this.options.volume) || 0.16, 0.01, 0.32) * (isDownbeat ? preset.downbeatGain : 0.9);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(preset.filterHz, when);
    filter.Q.setValueAtTime(0.6, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + preset.attackSeconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + preset.decaySeconds);
    filter.connect(gain);
    gain.connect(this.context.destination);

    const oscillators = preset.frequencies.map((frequency, index) => {
      const oscillator = this.context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency * (isDownbeat && index === 0 ? 1.025 : 1), when);
      const partialGain = this.context.createGain();
      partialGain.gain.setValueAtTime(preset.harmonics[index] || 0.1, when);
      oscillator.connect(partialGain);
      partialGain.connect(filter);
      oscillator.start(when);
      oscillator.stop(when + preset.decaySeconds + 0.012);
      return { oscillator, partialGain };
    });
    const voice = { oscillators, filter, gain };
    this.activeNodes.push(voice);
    let pending = oscillators.length;
    oscillators.forEach(({ oscillator }) => {
      oscillator.onended = () => {
        pending -= 1;
        if (pending > 0) return;
        try {
          oscillators.forEach(({ oscillator: item, partialGain }) => { item.disconnect(); partialGain.disconnect(); });
          filter.disconnect();
          gain.disconnect();
        } catch { /* already released */ }
        this.activeNodes = this.activeNodes.filter((node) => node !== voice);
      };
    });
  }

  stop() {
    this.running = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.timeoutIds.forEach((id) => window.clearTimeout(id));
    this.timeoutIds = [];
    const now = this.context?.state === "closed" ? 0 : this.context?.currentTime;
    this.activeNodes.forEach(({ oscillators, filter, gain }) => {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0.0001, now);
        oscillators.forEach(({ oscillator, partialGain }) => {
          oscillator.stop(now);
          oscillator.disconnect();
          partialGain.disconnect();
        });
        filter.disconnect();
        gain.disconnect();
      } catch {
        // Nodes may already have reached their scheduled end.
      }
    });
    this.activeNodes = [];
  }

  getDiagnostics() {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }
}

export const METRONOME_LOOKAHEAD = { LOOKAHEAD_MS, SCHEDULE_AHEAD_SECONDS };
