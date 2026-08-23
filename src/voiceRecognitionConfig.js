// Tuned for one unaccompanied humming voice. Keep every threshold here so a
// recorded diagnostic can always be traced back to the exact configuration.
export const VOICE_RECOGNITION_CONFIG = Object.freeze({
  version: "hummely-voice-v7-articulation-events",
  basicPitch: Object.freeze({
    onsetThreshold: 0.25,
    frameThreshold: 0.25,
    minimumNoteFrames: 5,
    inferOnsets: true,
    minimumFrequency: 75,
    maximumFrequency: 1050,
    energyToleranceFrames: 8
  }),
  voice: Object.freeze({
    minimumMidi: 36,
    maximumMidi: 96,
    minimumDurationSeconds: 0.07,
    minimumAmplitude: 0.16,
    relativeAmplitudeFloor: 0.36,
    maximumVoiceOverlapSeconds: 0.055,
    reliableOnsetThreshold: 0.32,
    energyValleyRatio: 0.58,
    energyReattackRatio: 1.35,
    modelReattackMinimumOnset: 0.38,
    modelReattackMinimumIntervalSeconds: 0.045,
    maximumMergeGapSeconds: 0.065,
    maximumTailGapSeconds: 0.13,
    maximumDriftSemitones: 1,
    maximumDriftFragmentSeconds: 0.17,
    maximumTailFragmentSeconds: 0.28,
    maximumLeadInFragmentSeconds: 0.17,
    leadInAmplitudeRatio: 0.62,
    terminalTailWindowSeconds: 0.62,
    // A phrase only ends after sustained unvoiced audio. Short vowels,
    // consonants and detector dropouts remain part of the same musical breath.
    phraseBreakMinimumSeconds: 0.3,
    phraseBreakEnergyFloor: 0.018,
    phraseBreakEnergyRatio: 0.3,
    phraseBridgeMaximumSeconds: 0.18,
    phraseQuietFrameSeconds: 0.03,
    phraseQuietCoverage: 0.76,
    manualBreathMinimumSeconds: 0.16,
    explicitReattackRequiresGapSeconds: 0.18,
    articulationBoundaryWindowSeconds: 0.085,
    articulationSplitScore: 0.62,
    articulationMinimumSegmentSeconds: 0.085,
    fastArticulationMinimumSegmentSeconds: 0.038,
    onsetStabilityMinimumSeconds: 0.05,
    onsetStabilityMaximumSeconds: 0.15,
    onsetStabilityRelativeDuration: 0.22,
    articulationReliableOnsetScore: 0.72
  }),
  // This narrow fallback reads Basic Pitch's own frame activations. It is not
  // driven by consonants, energy, or spectral flux, and only repairs a clearly
  // under-counted fast multi-pitch run.
  fastPitchRecovery: Object.freeze({
    minimumFrameConfidence: 0.42,
    minimumStableFrames: 3,
    minimumStableSeconds: 0.03,
    minimumDistinctCenters: 3,
    minimumPitchRangeSemitones: 2,
    maximumFrameGapSeconds: 0.03,
    maximumRegionGapSeconds: 0.06,
    maximumRunSeconds: 0.72,
    maximumCoverageSlackSeconds: 0.1
  }),
  articulation: Object.freeze({
    frameSeconds: 0.018,
    hopSeconds: 0.009,
    // Raw peaks are clustered by their evidence; do not discard fast syllables
    // with one global spacing threshold before that decision can be made.
    clusterBaseSeconds: 0.034,
    initialOnsetWindowSeconds: 0.085,
    minimumRapidReattackSeconds: 0.045,
    independentValleyRatio: 0.74,
    minimumNonPeriodicChange: 0.26,
    minimumScore: 0.54,
    minimumEnergyRise: 1.45,
    minimumFluxRatio: 1.2,
    minimumBasicPitchOnset: 0.16,
    energyRiseForFullScore: 2.4,
    fluxForFullScore: 3.1,
    zcrChangeForFullScore: 2.2,
    energyWeight: 0.42,
    fluxWeight: 0.28,
    nonPeriodicWeight: 0.12,
    basicPitchOnsetWeight: 0.34
  })
});

// The interpreter deliberately sits after Basic Pitch. It decides whether model
// events represent separate sung notes; it does not change the model itself.
export const HUMMING_INTERPRETER_VERSION = "hummely-humming-interpreter-v5-articulation-events";

export const HUMMING_INTERPRETER_MODES = Object.freeze({
  smooth: Object.freeze({
    label: "平滑",
    shortDescription: "更少碎音",
    description: "强力合并颤音、滑音和自然收尾，适合被切出很多短音的哼唱。",
    maximumMergeGapSeconds: 0.14,
    maximumTailGapSeconds: 0.2,
    maximumDriftSemitones: 2,
    maximumDriftFragmentSeconds: 0.42,
    maximumTailFragmentSeconds: 0.46,
    minimumStablePitchSeconds: 0.28,
    minimumDistinctPitchSemitones: 1,
    terminalTailWindowSeconds: 0.78,
    minimumFastPitchSeconds: 0.15,
    fastPitchOnsetThreshold: 0.36,
    fastPitchArticulationScore: 0.68,
    fastRunWindowSeconds: 0.16
  }),
  standard: Object.freeze({
    label: "标准",
    shortDescription: "平衡切分",
    description: "平衡自然哼唱的连贯感与真正新音符的切分，适合大多数录音。",
    maximumMergeGapSeconds: 0.105,
    maximumTailGapSeconds: 0.16,
    maximumDriftSemitones: 1,
    maximumDriftFragmentSeconds: 0.29,
    maximumTailFragmentSeconds: 0.34,
    minimumStablePitchSeconds: 0.2,
    minimumDistinctPitchSemitones: 1,
    terminalTailWindowSeconds: 0.68,
    minimumFastPitchSeconds: 0.085,
    fastPitchOnsetThreshold: 0.23,
    fastPitchArticulationScore: 0.56,
    fastRunWindowSeconds: 0.13
  }),
  detailed: Object.freeze({
    label: "精细",
    shortDescription: "保留短音",
    description: "保留更多快速音和短经过音，适合节奏更快、音符更清楚的旋律。",
    maximumMergeGapSeconds: 0.075,
    maximumTailGapSeconds: 0.12,
    maximumDriftSemitones: 1,
    maximumDriftFragmentSeconds: 0.16,
    maximumTailFragmentSeconds: 0.23,
    minimumStablePitchSeconds: 0.12,
    minimumDistinctPitchSemitones: 1,
    terminalTailWindowSeconds: 0.52,
    minimumFastPitchSeconds: 0.055,
    fastPitchOnsetThreshold: 0.16,
    fastPitchArticulationScore: 0.46,
    fastRunWindowSeconds: 0.11
  })
});

export const RECOGNITION_ENGINE_VERSION = "basic-pitch-ts@1.0.1+hummely-voice-v7-articulation-events";

export function getVoiceRecognitionConfigSnapshot() {
  return JSON.parse(JSON.stringify({
    ...VOICE_RECOGNITION_CONFIG,
    hummingInterpreterVersion: HUMMING_INTERPRETER_VERSION,
    hummingInterpreterModes: HUMMING_INTERPRETER_MODES
  }));
}
