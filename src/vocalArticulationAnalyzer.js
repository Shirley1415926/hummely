function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function frameFeatures(samples, start, size, previousBands) {
  let squareTotal = 0;
  let crossings = 0;
  let previous = samples[start] || 0;
  const spectralBins = [2, 4, 7, 11, 17, 25, 37, 55];
  const bands = spectralBins.map((bin) => {
    let real = 0;
    let imaginary = 0;
    for (let offset = 0; offset < size; offset += 2) {
      const sample = samples[start + offset] || 0;
      const window = 0.5 - 0.5 * Math.cos((Math.PI * 2 * offset) / Math.max(1, size - 1));
      const angle = (Math.PI * 2 * bin * offset) / size;
      real += sample * window * Math.cos(angle);
      imaginary -= sample * window * Math.sin(angle);
    }
    return real * real + imaginary * imaginary;
  });
  for (let offset = 0; offset < size; offset += 1) {
    const sample = samples[start + offset] || 0;
    squareTotal += sample * sample;
    if ((sample >= 0) !== (previous >= 0)) crossings += 1;
    previous = sample;
  }
  const spectralFlux = previousBands
    ? bands.reduce((total, value, index) => total + Math.max(0, value - previousBands[index]), 0)
    : 0;
  return { rms: Math.sqrt(squareTotal / size), zcr: crossings / size, bands, spectralFlux };
}

function onsetAtTime(onsets, time, sampleRate) {
  if (!onsets?.length) return 0;
  const frame = Math.max(0, Math.round(time * (sampleRate / 256)));
  let strongest = 0;
  for (let offset = -1; offset <= 1; offset += 1) {
    const row = onsets[frame + offset];
    if (!row) continue;
    for (let index = 0; index < row.length; index += 1) strongest = Math.max(strongest, row[index] || 0);
  }
  return strongest;
}

function localMaximum(values, index) {
  return values[index] >= (values[index - 1] ?? -Infinity) && values[index] >= (values[index + 1] ?? -Infinity);
}

function unique(values) {
  return [...new Set(values)];
}

function candidateSources(frame, settings) {
  const energyAttack = frame.energyRise >= (settings.minimumEnergyRise || 1.45);
  const spectralTransient = frame.fluxRatio >= (settings.minimumFluxRatio || 1.2);
  const modelOnset = frame.basicPitchOnset >= (settings.minimumBasicPitchOnset || 0.16);
  const nonPeriodicTransient = frame.nonPeriodicChange >= (settings.minimumNonPeriodicChange || 0.26);
  return {
    energyAttack,
    spectralTransient,
    modelOnset,
    nonPeriodicTransient,
    labels: [
      energyAttack ? "energy-attack" : null,
      spectralTransient ? "spectral-flux" : null,
      modelOnset ? "basic-pitch-onset" : null,
      nonPeriodicTransient ? "non-periodic-transient" : null
    ].filter(Boolean)
  };
}

function createRawCandidate(frame, index, settings) {
  const sources = candidateSources(frame, settings);
  const independentEnergyReset = sources.energyAttack &&
    frame.energyValleyRatio <= (settings.independentValleyRatio || 0.74) &&
    sources.spectralTransient;
  const modelTransient = sources.modelOnset && (sources.spectralTransient || sources.nonPeriodicTransient);
  return {
    id: "peak-" + (index + 1),
    time: Number(frame.time.toFixed(6)),
    articulationOnsetScore: Number(frame.articulationOnsetScore.toFixed(4)),
    energyRise: Number(frame.energyRise.toFixed(4)),
    energyValleyRatio: Number(frame.energyValleyRatio.toFixed(4)),
    spectralFlux: Number(frame.fluxRatio.toFixed(4)),
    basicPitchOnset: Number(frame.basicPitchOnset.toFixed(4)),
    nonPeriodicChange: Number(frame.nonPeriodicChange.toFixed(4)),
    sources: sources.labels,
    independentEnergyReset,
    modelTransient,
    reason: sources.modelOnset && sources.energyAttack
      ? "audio-attack-and-basic-pitch-onset"
      : sources.modelOnset
        ? "basic-pitch-onset"
        : "audio-attack"
  };
}

function isIndependentReattack(event, candidate, settings) {
  const gap = candidate.time - event.lastPeakTime;
  if (gap <= (settings.clusterBaseSeconds || 0.034)) return false;
  const strongReset = candidate.independentEnergyReset;
  const modelAndTransient = candidate.modelTransient &&
    gap >= (settings.minimumRapidReattackSeconds || 0.045);
  // A second feature peak without a fresh valley is usually the same la: its
  // consonant, vowel entrance and model onset have arrived at different frames.
  return strongReset || modelAndTransient;
}

/**
 * Clusters the several feature peaks caused by one syllable into one event.
 * A close peak starts a new event only if it independently demonstrates a new
 * attack, so fast la-la can survive while la's internal attack/vowel peaks do not.
 */
export function clusterArticulationCandidates(rawCandidates, config) {
  const settings = config?.articulation || {};
  const events = [];
  (rawCandidates || []).forEach((candidate) => {
    const previous = events[events.length - 1];
    const newAction = !previous || isIndependentReattack(previous, candidate, settings);
    if (newAction) {
      events.push({
        id: "articulation-" + (events.length + 1),
        time: candidate.time,
        startTime: candidate.time,
        endTime: candidate.time,
        lastPeakTime: candidate.time,
        articulationOnsetScore: candidate.articulationOnsetScore,
        energyRise: candidate.energyRise,
        energyValleyRatio: candidate.energyValleyRatio,
        spectralFlux: candidate.spectralFlux,
        basicPitchOnset: candidate.basicPitchOnset,
        nonPeriodicChange: candidate.nonPeriodicChange,
        sources: [...candidate.sources],
        peakCount: 1,
        rawPeakIds: [candidate.id],
        rawPeaks: [{ ...candidate }],
        // The first detectable peak is not always the recording's first onset.
        // A clear reset after an already voiced lead-in is still a re-attack.
        isIndependentReattack: Boolean(previous) || (
          candidate.time > (settings.initialOnsetWindowSeconds || 0.085) && candidate.independentEnergyReset
        ),
        reason: previous || (candidate.time > (settings.initialOnsetWindowSeconds || 0.085) && candidate.independentEnergyReset)
          ? "independent-rearticulation"
          : "initial-articulation"
      });
      return;
    }

    previous.endTime = candidate.time;
    previous.lastPeakTime = candidate.time;
    previous.peakCount += 1;
    previous.rawPeakIds.push(candidate.id);
    previous.rawPeaks.push({ ...candidate });
    previous.sources = unique([...previous.sources, ...candidate.sources]);
    if (candidate.articulationOnsetScore > previous.articulationOnsetScore) {
      previous.time = candidate.time;
      previous.articulationOnsetScore = candidate.articulationOnsetScore;
      previous.energyRise = candidate.energyRise;
      previous.energyValleyRatio = candidate.energyValleyRatio;
      previous.spectralFlux = candidate.spectralFlux;
      previous.basicPitchOnset = candidate.basicPitchOnset;
      previous.nonPeriodicChange = candidate.nonPeriodicChange;
    }
    previous.reason = "clustered-single-articulation";
  });

  return events.map((event) => ({
    ...event,
    clustered: event.peakCount > 1,
    // Only a later, independently supported action may create a new score note.
    canSplitStableNote: event.isIndependentReattack,
    lastPeakTime: undefined
  }));
}

/**
 * Analyses raw local audio for consonant-like re-attacks. Pitch is deliberately
 * absent from this analysis: it can decide a time boundary, never a MIDI value.
 */
export function analyzeVocalArticulation(samples, {
  sampleRate = 22050,
  onsets = [],
  config
} = {}) {
  const settings = config?.articulation || {};
  const frameSeconds = settings.frameSeconds || 0.024;
  const hopSeconds = settings.hopSeconds || 0.012;
  const frameSize = Math.max(32, Math.round(frameSeconds * sampleRate));
  const hopSize = Math.max(16, Math.round(hopSeconds * sampleRate));
  const frames = [];
  let previousBands = null;
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const feature = frameFeatures(samples, start, frameSize, previousBands);
    previousBands = feature.bands;
    frames.push({ time: (start + frameSize / 2) / sampleRate, ...feature });
  }

  const rmsMedian = Math.max(median(frames.map((frame) => frame.rms)), 0.00001);
  const fluxMedian = Math.max(median(frames.map((frame) => frame.spectralFlux)), 0.0000001);
  const zcrMedian = Math.max(median(frames.map((frame) => frame.zcr)), 0.00001);
  const scores = [];

  frames.forEach((frame, index) => {
    const previous = frames[index - 1];
    const valley = frames.slice(Math.max(0, index - 4), index)
      .reduce((minimum, item) => Math.min(minimum, item.rms), frame.rms);
    const energyRise = frame.rms / Math.max(valley, rmsMedian * 0.12, 0.00001);
    const energyAttack = clamp((energyRise - 1) / Math.max(0.1, (settings.energyRiseForFullScore || 2.4) - 1));
    const flux = clamp(frame.spectralFlux / (fluxMedian * (settings.fluxForFullScore || 3.1)));
    const nonPeriodic = clamp(Math.abs(frame.zcr - (previous?.zcr ?? frame.zcr)) / (zcrMedian * (settings.zcrChangeForFullScore || 2.2)));
    const basicPitchOnset = onsetAtTime(onsets, frame.time, sampleRate);
    const score = clamp(
      energyAttack * (settings.energyWeight || 0.42) +
      flux * (settings.fluxWeight || 0.28) +
      nonPeriodic * (settings.nonPeriodicWeight || 0.12) +
      basicPitchOnset * (settings.basicPitchOnsetWeight || 0.34),
      0,
      1
    );
    frame.energyRise = energyRise;
    frame.energyValleyRatio = valley / Math.max(frame.rms, 0.00001);
    frame.fluxRatio = frame.spectralFlux / fluxMedian;
    frame.basicPitchOnset = basicPitchOnset;
    frame.articulationOnsetScore = score;
    frame.nonPeriodicChange = nonPeriodic;
    scores.push(score);
  });

  // Do not apply a candidate spacing rule here. Fast syllables need all local
  // peaks preserved; clusterArticulationCandidates decides which peaks are one action.
  const rawCandidates = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame, index }) => {
      const sources = candidateSources(frame, settings);
      const scoreSupported = frame.articulationOnsetScore >= (settings.minimumScore || 0.54);
      return scoreSupported && localMaximum(scores, index) &&
        ((sources.energyAttack && sources.spectralTransient) || sources.modelOnset);
    })
    .map(({ frame, index }) => createRawCandidate(frame, index, settings));
  const articulationEvents = clusterArticulationCandidates(rawCandidates, config);

  return {
    sampleRate,
    frameSeconds,
    hopSeconds,
    frameCount: frames.length,
    medianRms: rmsMedian,
    medianSpectralFlux: fluxMedian,
    rawCandidates,
    articulationEvents,
    // Compatibility alias. New callers should read articulationEvents.
    candidates: articulationEvents,
    frameSummary: frames.map((frame) => ({
      time: Number(frame.time.toFixed(6)),
      rms: Number(frame.rms.toFixed(6)),
      energyRise: Number(frame.energyRise.toFixed(4)),
      energyValleyRatio: Number(frame.energyValleyRatio.toFixed(4)),
      spectralFlux: Number(frame.fluxRatio.toFixed(4)),
      basicPitchOnset: Number(frame.basicPitchOnset.toFixed(4)),
      articulationOnsetScore: Number(frame.articulationOnsetScore.toFixed(4))
    }))
  };
}

export function articulationEvidenceNear(time, analysis, windowSeconds = 0.075) {
  const events = analysis?.articulationEvents || analysis?.candidates || [];
  return events
    .filter((event) => Math.abs(event.time - time) <= windowSeconds)
    .sort((left, right) => right.articulationOnsetScore - left.articulationOnsetScore || Math.abs(left.time - time) - Math.abs(right.time - time))[0] || null;
}
