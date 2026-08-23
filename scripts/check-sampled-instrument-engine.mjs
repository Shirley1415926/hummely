import assert from "node:assert/strict";
import { SAMPLED_INSTRUMENTS, isSampledInstrument } from "../src/sampledInstrumentEngine.js";

assert.deepEqual(Object.keys(SAMPLED_INSTRUMENTS), ["Piano", "Mallet"]);
assert.equal(isSampledInstrument("Piano"), true);
assert.equal(isSampledInstrument("Mallet"), true);
assert.equal(isSampledInstrument("Violin"), false);

const piano = SAMPLED_INSTRUMENTS.Piano;
assert.equal(piano.factory, "SplendidGrandPiano");
assert.equal(piano.sampleLicense, "Public Domain");
assert.ok(piano.sourceUrl.startsWith("https://github.com/sfzinstruments/"));

const mallet = SAMPLED_INSTRUMENTS.Mallet;
assert.equal(mallet.factory, "Mallet");
assert.equal(mallet.instrument, "Xylophone - Soft Mallets");
assert.equal(mallet.sampleLicense, "CC0 1.0");
assert.ok(mallet.sourceUrl.startsWith("https://github.com/sgossner/"));

console.log(JSON.stringify({
  status: "passed",
  instruments: Object.values(SAMPLED_INSTRUMENTS).map(({ id, label, sourceName, sampleLicense }) => ({ id, label, sourceName, sampleLicense }))
}, null, 2));
