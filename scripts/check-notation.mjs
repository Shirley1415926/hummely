import { DEFAULT_TONIC, getJianpuNote, tonicPitchClass } from "../src/notationUtils.js";

const cases = [
  { name: "G3 是低八度 5", midi: 55, tonic: "C", degree: "5", octaveOffset: -1 },
  { name: "G4 是中间音区 5", midi: 67, tonic: "C", degree: "5", octaveOffset: 0 },
  { name: "G5 是高八度 5", midi: 79, tonic: "C", degree: "5", octaveOffset: 1 },
  { name: "G2 是低两个八度 5", midi: 43, tonic: "C", degree: "5", octaveOffset: -2 },
  { name: "C#4 显示升 1", midi: 61, tonic: "C", degree: "1", accidental: "#", octaveOffset: 0 },
  { name: "D 调中 A4 是 5", midi: 69, tonic: "D", degree: "5", octaveOffset: 0 }
];

let failures = 0;
for (const item of cases) {
  const actual = getJianpuNote(item.midi, item.tonic);
  const passed = actual.degree === item.degree && actual.octaveOffset === item.octaveOffset &&
    (item.accidental === undefined || actual.accidental === item.accidental);
  console.log(`${passed ? "PASS" : "FAIL"} ${item.name}: ${actual.accidental}${actual.degree}, octave ${actual.octaveOffset}`);
  if (!passed) failures += 1;
}

const flatPassed = tonicPitchClass("Bb") === 10 && tonicPitchClass("Db") === 1 && DEFAULT_TONIC === "C";
console.log(`${flatPassed ? "PASS" : "FAIL"} 降号 tonic 映射与默认 1=C`);
if (!flatPassed) failures += 1;

if (failures) process.exitCode = 1;
