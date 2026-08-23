// Sampling is loaded only after a user asks to hear an instrument. The app shell
// never imports smplr or fetches samples on the recording screen.
export const SAMPLED_INSTRUMENTS = Object.freeze({
  Piano: Object.freeze({
    id: "Piano",
    label: "钢琴",
    factory: "SplendidGrandPiano",
    library: "smplr",
    sourceName: "Splendid Grand Piano",
    sourceUrl: "https://github.com/sfzinstruments/SplendidGrandPiano",
    sampleLicense: "Public Domain",
    volume: 72,
    releaseSeconds: 0.32
  }),
  Mallet: Object.freeze({
    id: "Mallet",
    label: "木琴",
    factory: "Mallet",
    instrument: "Xylophone - Soft Mallets",
    library: "Versilian Community Sample Library",
    sourceName: "VCSL Xylophone - Soft Mallets",
    sourceUrl: "https://github.com/sgossner/VCSL",
    sampleLicense: "CC0 1.0",
    volume: 62,
    releaseSeconds: 0.14
  })
});

const SAMPLE_CACHE_NAME = "hummely-sampled-instruments-v1";
const LOAD_TIMEOUT_MS = 15_000;

function uniqueMidis(values) {
  return [...new Set((values || [])
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 36 && value <= 96))]
    .sort((left, right) => left - right);
}

function waitFor(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => window.clearTimeout(timer));
}

function readTransferBytes(since) {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
  const entries = performance.getEntriesByType("resource").filter((entry) =>
    entry.startTime >= since && /smpldsnds\.github\.io|githubusercontent\.com/u.test(entry.name)
  );
  const bytes = entries.reduce((total, entry) => total + (Number(entry.transferSize) || 0), 0);
  // Cross-origin servers may not expose transferSize without Timing-Allow-Origin.
  return bytes > 0 ? bytes : null;
}

function canUseCacheStorage() {
  return typeof window !== "undefined" && window.isSecureContext && "caches" in window;
}

/**
 * A small adapter around smplr. UI code only receives load/play/stop/destroy
 * operations, leaving the existing oscillator implementation as an explicit fallback.
 */
export function createSampledInstrumentEngine(context, destination, { onStatus } = {}) {
  let smplrModulePromise = null;
  let storage = null;
  const instances = new Map();
  const activeStops = new Set();

  async function getModule() {
    if (!smplrModulePromise) smplrModulePromise = import("smplr");
    const smplr = await smplrModulePromise;
    if (!storage && canUseCacheStorage()) storage = smplr.CacheStorage(SAMPLE_CACHE_NAME);
    return smplr;
  }

  function report(status) {
    onStatus?.(status);
  }

  async function load(instrumentId, midis = []) {
    const definition = SAMPLED_INSTRUMENTS[instrumentId];
    if (!definition) throw new Error("这个乐器暂时没有可用的真实采样。");
    const requestedMidis = uniqueMidis(midis);
    const existing = instances.get(instrumentId);
    if (existing && requestedMidis.every((midi) => existing.midis.has(midi))) {
      report({ state: "ready", instrumentId, definition, cached: true, loaded: existing.loaded, total: existing.total, transferBytes: 0 });
      return { ...existing, cached: true, definition };
    }

    const smplr = await getModule();
    const startedAt = performance.now();
    let loaded = 0;
    let total = 0;
    const onLoadProgress = (progress) => {
      loaded = Number(progress?.loaded) || loaded;
      total = Number(progress?.total) || total;
      report({ state: "loading", instrumentId, definition, loaded, total, cached: false });
    };
    const common = {
      destination,
      volume: definition.volume,
      ...(storage ? { storage } : {}),
      onLoadProgress
    };
    const instance = definition.factory === "SplendidGrandPiano"
      ? smplr.SplendidGrandPiano(context, {
          ...common,
          decayTime: definition.releaseSeconds,
          // Load only pitches present in the current melody, never an entire GM bank.
          notesToLoad: { notes: requestedMidis.length ? requestedMidis : [60], velocityRange: [30, 110] }
        })
      : smplr.Mallet(context, { ...common, instrument: definition.instrument });

    try {
      await waitFor(instance.ready, LOAD_TIMEOUT_MS, definition.label + "音色加载超时，请检查网络后重试。");
    } catch (error) {
      try { instance.dispose(); } catch { /* best effort after a failed load */ }
      throw error;
    }

    if (existing) {
      try { existing.instance.dispose(); } catch { /* the old voice may already be released */ }
    }
    const loadedInstance = {
      instance,
      midis: new Set(requestedMidis),
      loaded,
      total,
      transferBytes: readTransferBytes(startedAt)
    };
    instances.set(instrumentId, loadedInstance);
    report({ state: "ready", instrumentId, definition, cached: false, loaded, total, transferBytes: loadedInstance.transferBytes });
    return { ...loadedInstance, cached: false, definition };
  }

  function start(instrumentId, event) {
    const record = instances.get(instrumentId);
    if (!record) throw new Error("音色还没有加载完成。");
    let stop = null;
    stop = record.instance.start({
      ...event,
      onEnded: () => {
        activeStops.delete(stop);
        event.onEnded?.();
      }
    });
    activeStops.add(stop);
    return stop;
  }

  function stopAll(time) {
    activeStops.forEach((stop) => {
      try { stop(time); } catch { /* a scheduled voice may already have ended */ }
    });
    activeStops.clear();
    instances.forEach(({ instance }) => {
      try { instance.stop(time === undefined ? undefined : { time }); } catch { /* ignored during teardown */ }
    });
  }

  function destroy() {
    stopAll();
    instances.forEach(({ instance }) => {
      try { instance.dispose(); } catch { /* ignored during teardown */ }
    });
    instances.clear();
  }

  return { load, start, stopAll, destroy, definitions: SAMPLED_INSTRUMENTS };
}

export function isSampledInstrument(instrumentId) {
  return Boolean(SAMPLED_INSTRUMENTS[instrumentId]);
}
