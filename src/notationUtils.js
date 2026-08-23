const pitchClasses = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const jianpuDegrees = [
  { degree: "1", accidental: "" },
  { degree: "1", accidental: "#" },
  { degree: "2", accidental: "" },
  { degree: "2", accidental: "#" },
  { degree: "3", accidental: "" },
  { degree: "4", accidental: "" },
  { degree: "4", accidental: "#" },
  { degree: "5", accidental: "" },
  { degree: "5", accidental: "#" },
  { degree: "6", accidental: "" },
  { degree: "6", accidental: "#" },
  { degree: "7", accidental: "" }
];

export const DEFAULT_TONIC = "C";

const tonicClasses = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5,
  "F#": 6, GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11
};

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function parseTimeSignature(value = "4/4") {
  const [numerator, denominator] = String(value).split("/").map(Number);
  if (![3, 4, 6].includes(numerator) || ![4, 8].includes(denominator)) return { value: "4/4", numerator: 4, denominator: 4, measureBeats: 4 };
  return { value: numerator + "/" + denominator, numerator, denominator, measureBeats: numerator * (4 / denominator) };
}

export function tonicPitchClass(tonic = DEFAULT_TONIC) {
  const normalized = String(tonic).trim().replace("♭", "b").toUpperCase();
  return tonicClasses[normalized] ?? 0;
}

export function getJianpuNote(midi, tonic = DEFAULT_TONIC) {
  const tonicMidi = 60 + tonicPitchClass(tonic);
  const relativeSemitones = Math.round(midi) - tonicMidi;
  const pitchClassOffset = mod(relativeSemitones, 12);
  const octaveOffset = Math.floor((relativeSemitones - pitchClassOffset) / 12);
  const mapping = jianpuDegrees[pitchClassOffset];

  return {
    degree: mapping.degree,
    accidental: mapping.accidental,
    octaveOffset,
    pitchClassOffset,
    label: mapping.accidental + mapping.degree
  };
}

export function midiToVexKey(midi) {
  const rounded = Math.round(midi);
  const pitchClass = mod(rounded, 12);
  const pitchName = pitchClasses[pitchClass];
  const letter = pitchName[0].toLowerCase();
  const accidental = pitchName.slice(1);
  const octave = Math.floor(rounded / 12) - 1;
  return { key: letter + accidental + "/" + octave, accidental };
}

export function beatsToVexDuration(beats) {
  const rounded = Math.round(beats * 4) / 4;
  if (rounded === 0.25) return { duration: "16", dotted: false };
  if (rounded === 0.5) return { duration: "8", dotted: false };
  if (rounded === 0.75) return { duration: "8", dotted: true };
  if (rounded === 1) return { duration: "q", dotted: false };
  if (rounded === 1.5) return { duration: "q", dotted: true };
  if (rounded === 2) return { duration: "h", dotted: false };
  if (rounded === 3) return { duration: "h", dotted: true };
  return { duration: "w", dotted: false };
}

// Entries may be notes or rests. Keeping them together ensures both score views
// use the same measure boundary instead of assuming every song is 4/4.
export function splitIntoMeasures(entries, timeSignature = "4/4") {
  const { measureBeats } = parseTimeSignature(timeSignature);
  const measures = [];
  let current = [];
  let elapsedBeats = 0;

  entries.forEach((entry, index) => {
    const beats = Number(entry.note?.durationBeats ?? entry.note?.beats ?? entry.rest?.durationBeats ?? entry.beats) || 1;
    if (current.length && elapsedBeats + beats > measureBeats + 0.01) {
      measures.push(current);
      current = [];
      elapsedBeats = 0;
    }
    current.push({ ...entry, renderIndex: index });
    elapsedBeats += beats;
    if (elapsedBeats >= measureBeats - 0.01) {
      measures.push(current);
      current = [];
      elapsedBeats = 0;
    }
  });

  if (current.length) measures.push(current);
  return measures.length ? measures : [[]];
}
