const DATABASE_NAME = "hummely-melody-studio";
const DATABASE_VERSION = 5;
const PROJECTS_STORE = "projects";
export const PROJECT_SCHEMA_VERSION = 5;

function cloneNotes(notes) {
  return Array.isArray(notes) ? notes.map((note) => ({ ...note })) : [];
}

// Version 1 projects remain readable. They are normalized in memory and written
// back as schema v2 on their next autosave, so existing recordings are never lost.
function normalizeTranscript(transcript, fallback = {}) {
  const processedDetectedNotes = cloneNotes(
    transcript?.processedDetectedNotes?.length
      ? transcript.processedDetectedNotes
      : transcript?.interpretedNotes?.length
        ? transcript.interpretedNotes
        : fallback.processedDetectedNotes
  );
  return {
    rawBasicPitchNotes: cloneNotes(transcript?.rawBasicPitchNotes?.length ? transcript.rawBasicPitchNotes : fallback.rawBasicPitchNotes),
    processedDetectedNotes,
    interpretedNotes: cloneNotes(transcript?.interpretedNotes?.length ? transcript.interpretedNotes : processedDetectedNotes),
    editedNotes: cloneNotes(transcript?.editedNotes?.length ? transcript.editedNotes : fallback.editedNotes?.length ? fallback.editedNotes : processedDetectedNotes),
    recognitionDiagnostics: transcript?.recognitionDiagnostics || fallback.recognitionDiagnostics || null,
    audioAnalysis: transcript?.audioAnalysis || fallback.audioAnalysis || transcript?.recognitionDiagnostics?.audioAnalysis || fallback.recognitionDiagnostics?.audioAnalysis || null,
    recognitionEngine: transcript?.recognitionEngine || fallback.recognitionEngine || null,
    recognitionVersion: transcript?.recognitionVersion || fallback.recognitionVersion || null,
    interpreterMode: transcript?.interpreterMode || fallback.interpreterMode || "standard",
    interpreterVersion: transcript?.interpreterVersion || fallback.interpreterVersion || null,
    melody: transcript?.melody || fallback.melody || null,
    originalRhythmNotes: cloneNotes(transcript?.originalRhythmNotes?.length ? transcript.originalRhythmNotes : fallback.originalRhythmNotes),
    quantizedNotes: cloneNotes(transcript?.quantizedNotes?.length ? transcript.quantizedNotes : fallback.quantizedNotes),
    rhythm: transcript?.rhythm || fallback.rhythm || null,
    updatedAt: transcript?.updatedAt || fallback.updatedAt || null
  };
}

export function normalizeProject(project) {
  if (!project) return project;
  const originalAudioBlob = project.originalAudioBlob || project.audioBlob || null;
  const tunedAudioBlob = project.tunedAudioBlob || null;
  const transcriptionSource = project.transcriptionSource === "tuned" && tunedAudioBlob ? "tuned" : "original";
  const legacyProcessedDetectedNotes = project.processedDetectedNotes?.length
    ? project.processedDetectedNotes
    : project.originalDetectedNotes;
  const activeTranscript = normalizeTranscript(
    project.transcriptions?.[transcriptionSource],
    { ...project, processedDetectedNotes: legacyProcessedDetectedNotes }
  );
  const transcriptions = { ...project.transcriptions };
  if (activeTranscript.processedDetectedNotes.length || activeTranscript.rawBasicPitchNotes.length) {
    transcriptions[transcriptionSource] = activeTranscript;
  }

  return {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    tonic: project.tonic || "C",
    // audioBlob remains as a compatibility alias for schema v1/v2 clients.
    audioBlob: originalAudioBlob,
    originalAudioBlob,
    tunedAudioBlob,
    transcriptionSource,
    tuningEnabled: Boolean(project.tuningEnabled),
    tuningMode: project.tuningMode || "free-chromatic",
    tuningStrength: project.tuningStrength || "natural",
    tuningVersion: project.tuningVersion || null,
    tuningStatus: project.tuningStatus || (tunedAudioBlob ? "ready" : "idle"),
    tuningCreatedAt: project.tuningCreatedAt || null,
    tuningDiagnostics: project.tuningDiagnostics || null,
    rawBasicPitchNotes: activeTranscript.rawBasicPitchNotes,
    processedDetectedNotes: activeTranscript.processedDetectedNotes,
    interpretedNotes: activeTranscript.interpretedNotes,
    // Keep this legacy field while existing clients are still able to read it.
    originalDetectedNotes: cloneNotes(activeTranscript.processedDetectedNotes),
    editedNotes: activeTranscript.editedNotes,
    recognitionDiagnostics: activeTranscript.recognitionDiagnostics,
    audioAnalysis: activeTranscript.audioAnalysis,
    recognitionEngine: activeTranscript.recognitionEngine,
    recognitionVersion: activeTranscript.recognitionVersion || project.recognitionVersion || null,
    interpreterMode: activeTranscript.interpreterMode,
    interpreterVersion: activeTranscript.interpreterVersion,
    originalRhythmNotes: activeTranscript.originalRhythmNotes,
    quantizedNotes: activeTranscript.quantizedNotes,
    rhythm: activeTranscript.rhythm || project.rhythm || null,
    metronome: project.metronome || null,
    transcriptions
  };
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地作品库暂时无法访问。"));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        const store = database.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地作品库。"));
  });
}

async function withStore(mode, work) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECTS_STORE, mode);
    const result = await work(transaction.objectStore(PROJECTS_STORE));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("保存作品时发生错误。"));
      transaction.onabort = () => reject(transaction.error || new Error("保存作品已取消。"));
    });
    return result;
  } finally {
    database.close();
  }
}

export async function saveProject(project) {
  return withStore("readwrite", (store) => requestAsPromise(store.put(normalizeProject(project))));
}

export async function getProject(id) {
  const project = await withStore("readonly", (store) => requestAsPromise(store.get(id)));
  return normalizeProject(project);
}

export async function listProjects() {
  const projects = await withStore("readonly", (store) => requestAsPromise(store.getAll()));
  return projects
    .map(normalizeProject)
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
}

export async function removeProject(id) {
  return withStore("readwrite", (store) => requestAsPromise(store.delete(id)));
}
