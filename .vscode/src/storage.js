const STORAGE_KEY = "really-notepad-notes";

function fallbackNote() {
  const now = Date.now();

  return {
    id: createId(),
    title: "",
    content: "",
    tags: [],
    images: [],
    pinned: false,
    createdAt: now,
    updatedAt: now
  };
}

export function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return "note-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

export function loadNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    const notes = Array.isArray(saved) ? saved : [];

    return notes.length > 0 ? notes : [fallbackNote()];
  } catch {
    return [fallbackNote()];
  }
}

export function saveNotes(notes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}
