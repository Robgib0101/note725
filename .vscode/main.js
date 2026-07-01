import { elements } from "./src/dom.js";
import { firebaseConfig, firestoreOptions } from "./firebase-config.js";
import { createFirestoreNotesStore } from "./src/firestore.js";
import { loadNotes, saveNotes, createId } from "./src/storage.js";
import {
  templates,
  formatDate,
  getTitle,
  getPreview,
  getSearchText,
  parseTags,
  getContentStats,
  getImageCount,
  getSafeFilename
} from "./src/text.js";
import { createImageBlocksFromFiles, renderImageBlocks } from "./src/images.js";
import { buildHtmlExport, buildTextExport } from "./src/export.js";

let notes = loadNotes();
let activeId = notes[0]?.id;
let saveTimer;
let saveRevision = 0;
let notesStore;
let unsubscribeNotes;
let isFocusMode = false;

function getActiveNote() {
  return notes.find((note) => note.id === activeId) ?? notes[0];
}

function persistNote(note) {
  if (!note) {
    return;
  }

  const revision = ++saveRevision;
  elements.saveStatus.textContent = notesStore?.enabled ? "동기화 중" : "저장 중";
  clearTimeout(saveTimer);

  saveTimer = setTimeout(async () => {
    try {
      saveNotes(notes);

      if (notesStore?.enabled) {
        await notesStore.saveNote(note);
      }

      if (revision === saveRevision) {
        elements.saveStatus.textContent = notesStore?.enabled ? "Firebase 저장됨" : "로컬 저장됨";
      }
    } catch (error) {
      console.error(error);
      elements.saveStatus.textContent = "저장 실패";
    }
  }, 160);
}

async function deleteNoteFromStore(noteId) {
  ++saveRevision;
  clearTimeout(saveTimer);

  try {
    saveNotes(notes);

    if (notesStore?.enabled && noteId) {
      elements.saveStatus.textContent = "삭제 동기화 중";
      await notesStore.deleteNote(noteId);
      elements.saveStatus.textContent = "Firebase 저장됨";
    } else {
      elements.saveStatus.textContent = "로컬 저장됨";
    }
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "삭제 실패";
  }
}

function sortNotes(noteList) {
  return [...noteList].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }

    return b.updatedAt - a.updatedAt;
  });
}

function renderList() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const filtered = sortNotes(notes).filter((note) => getSearchText(note).includes(query));

  elements.noteList.innerHTML = "";
  elements.noteCount.textContent = notes.length + "개";

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "검색 결과가 없습니다.";
    elements.noteList.append(empty);
    return;
  }

  filtered.forEach((note) => {
    const item = elements.template.content.firstElementChild.cloneNode(true);
    const imageTotal = getImageCount(note);
    const stats = getContentStats(note.content, imageTotal);
    const imageLabel = imageTotal ? " · 이미지 " + imageTotal + "개" : "";

    item.classList.toggle("is-active", note.id === activeId);
    item.querySelector(".note-item-title").textContent = (note.pinned ? "★ " : "") + getTitle(note);
    item.querySelector(".note-item-preview").textContent = getPreview(note);
    item.querySelector(".note-item-tags").textContent = note.tags.map((tag) => "#" + tag).join(" ");
    item.querySelector(".note-item-meta").textContent = formatDate(note.updatedAt) + " · " + stats.chars + "자" + imageLabel;
    item.addEventListener("click", () => {
      activeId = note.id;
      render();
    });
    elements.noteList.append(item);
  });
}

function renderImageBlocksForActiveNote() {
  const activeNote = getActiveNote();
  const blocks = activeNote?.images ?? [];

  renderImageBlocks(elements.imageBoard, blocks, {
    onTextInput: (blockId, patch) => updateImageBlock(blockId, patch, false),
    onBlockChange: (blockId, patch) => updateImageBlock(blockId, patch, true),
    onMove: moveImageBlock,
    onRemove: removeImageBlock
  });
}

function renderEditor() {
  const activeNote = getActiveNote();

  if (!activeNote) {
    createNote();
    return;
  }

  activeId = activeNote.id;
  elements.titleInput.value = activeNote.title;
  elements.tagInput.value = activeNote.tags.join(", ");
  elements.contentInput.value = activeNote.content;
  updateEditorMeta(activeNote);
  renderImageBlocksForActiveNote();
  elements.pinButton.classList.toggle("is-active", activeNote.pinned);
  elements.pinButton.textContent = activeNote.pinned ? "고정됨" : "고정";
  elements.focusButton.classList.toggle("is-active", isFocusMode);
  elements.focusButton.textContent = isFocusMode ? "목록" : "집중";
}

function render() {
  renderList();
  renderEditor();
}

function isEditingNote() {
  const activeElement = document.activeElement;

  return activeElement === elements.titleInput
    || activeElement === elements.tagInput
    || activeElement === elements.contentInput
    || elements.imageBoard.contains(activeElement);
}

function applyRemoteNotes(remoteNotes) {
  const previousActiveId = activeId;

  notes = remoteNotes;
  activeId = notes.some((note) => note.id === previousActiveId)
    ? previousActiveId
    : sortNotes(notes)[0]?.id;

  saveNotes(notes);
  renderList();

  if (activeId !== previousActiveId || !isEditingNote()) {
    renderEditor();
  } else {
    updateEditorMeta(getActiveNote());
  }

  elements.saveStatus.textContent = "Firebase 동기화됨";
}

async function connectFirestore() {
  elements.saveStatus.textContent = "Firebase 연결 중";

  try {
    notesStore = await createFirestoreNotesStore(firebaseConfig, firestoreOptions);

    if (!notesStore.enabled) {
      elements.saveStatus.textContent = "Firebase 설정 필요";
      return;
    }

    unsubscribeNotes = notesStore.subscribe(
      applyRemoteNotes,
      (error) => {
        console.error(error);
        elements.saveStatus.textContent = "Firebase 연결 실패";
      }
    );
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "Firebase 연결 실패";
  }
}

function createNote(initialContent = "") {
  const now = Date.now();
  const note = {
    id: createId(),
    title: "",
    content: initialContent,
    tags: [],
    images: [],
    pinned: false,
    createdAt: now,
    updatedAt: now
  };

  notes = [note, ...notes];
  activeId = note.id;
  elements.searchInput.value = "";
  persistNote(note);
  render();
  elements.titleInput.focus();
}

function updateEditorMeta(note) {
  const imageTotal = getImageCount(note);
  const stats = getContentStats(note.content, imageTotal);
  elements.currentDate.textContent = "수정 " + formatDate(note.updatedAt);
  elements.wordCount.textContent = stats.chars + "자 " + stats.words + "단어";
  elements.lineCount.textContent = stats.lines + "줄";
  elements.readTime.textContent = stats.readLabel;
  elements.imageCount.textContent = "이미지 " + stats.images + "개";
  elements.checklistStatus.textContent = "체크 " + stats.done + "/" + stats.checks;
}

function updateActiveNote(patch, shouldSyncEditor = true) {
  const now = Date.now();
  let updatedNote;

  notes = notes.map((note) => {
    if (note.id !== activeId) {
      return note;
    }

    const nextNote = {
      ...note,
      ...patch,
      updatedAt: now
    };

    updatedNote = nextNote;
    return nextNote;
  });

  persistNote(updatedNote);
  renderList();

  if (shouldSyncEditor) {
    renderEditor();
  } else if (updatedNote) {
    updateEditorMeta(updatedNote);
  }
}

function updateImageBlock(blockId, patch, shouldRenderImages) {
  const activeNote = getActiveNote();
  const nextImages = (activeNote.images ?? []).map((block) => {
    if (block.id !== blockId) {
      return block;
    }

    return {
      ...block,
      ...patch
    };
  });

  updateActiveNote({ images: nextImages }, false);

  if (shouldRenderImages) {
    renderImageBlocksForActiveNote();
  }
}

function moveImageBlock(blockId, direction) {
  const activeNote = getActiveNote();
  const nextImages = [...(activeNote.images ?? [])];
  const currentIndex = nextImages.findIndex((block) => block.id === blockId);
  const nextIndex = currentIndex + direction;

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= nextImages.length) {
    return;
  }

  const [block] = nextImages.splice(currentIndex, 1);
  nextImages.splice(nextIndex, 0, block);
  updateActiveNote({ images: nextImages });
}

function removeImageBlock(blockId) {
  const activeNote = getActiveNote();
  const nextImages = (activeNote.images ?? []).filter((block) => block.id !== blockId);
  updateActiveNote({ images: nextImages });
}

function deleteActiveNote() {
  let nextNote;
  let deletedNoteId;

  if (notes.length === 1) {
    nextNote = {
      ...notes[0],
      title: "",
      content: "",
      tags: [],
      images: [],
      pinned: false,
      updatedAt: Date.now()
    };
    notes = [nextNote];
  } else {
    deletedNoteId = activeId;
    notes = notes.filter((note) => note.id !== activeId);
    activeId = sortNotes(notes)[0]?.id;
  }

  if (deletedNoteId) {
    deleteNoteFromStore(deletedNoteId);
  } else {
    persistNote(nextNote);
  }

  render();
}

function downloadActiveNote() {
  const note = getActiveNote();
  const hasImages = getImageCount(note) > 0;
  const filename = getSafeFilename(getTitle(note), hasImages ? ".html" : ".txt");
  const body = hasImages ? buildHtmlExport(note) : buildTextExport(note);
  const type = hasImages ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getLineStart(value, position) {
  return value.lastIndexOf("\n", position - 1) + 1;
}

function insertAtCursor(text, wrapSelection = false) {
  const input = elements.contentInput;
  const value = input.value;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const selection = value.slice(start, end);
  let nextValue;
  let nextStart;
  let nextEnd;

  if (wrapSelection) {
    nextValue = value.slice(0, start) + text + selection + text + value.slice(end);
    nextStart = start + text.length;
    nextEnd = nextStart + selection.length;
  } else {
    nextValue = value.slice(0, start) + text + value.slice(end);
    nextStart = start + text.length;
    nextEnd = nextStart;
  }

  input.value = nextValue;
  input.focus();
  input.setSelectionRange(nextStart, nextEnd);
  updateActiveNote({ content: nextValue }, false);
}

function prefixCurrentLine(prefix) {
  const input = elements.contentInput;
  const value = input.value;
  const start = input.selectionStart;
  const lineStart = getLineStart(value, start);
  const needsBreak = lineStart > 0 && value[lineStart - 1] !== "\n";
  const insert = (needsBreak ? "\n" : "") + prefix;
  const nextValue = value.slice(0, lineStart) + insert + value.slice(lineStart);
  const nextCursor = start + insert.length;

  input.value = nextValue;
  input.focus();
  input.setSelectionRange(nextCursor, nextCursor);
  updateActiveNote({ content: nextValue }, false);
}

function applyFormat(action) {
  const nowLabel = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());

  const actions = {
    heading: () => prefixCurrentLine("## "),
    bold: () => insertAtCursor("**", true),
    bullet: () => prefixCurrentLine("- "),
    numbered: () => prefixCurrentLine("1. "),
    check: () => prefixCurrentLine("- [ ] "),
    quote: () => prefixCurrentLine("> "),
    date: () => insertAtCursor(nowLabel)
  };

  actions[action]?.();
}

function insertTemplate(templateName) {
  const template = templates[templateName];
  if (!template) {
    return;
  }

  const input = elements.contentInput;
  const joiner = input.value.trim() ? "\n\n" : "";
  insertAtCursor(joiner + template);
  elements.templateSelect.value = "";
}

function toggleChecklistAtCursor(event) {
  const input = elements.contentInput;
  const value = input.value;
  const cursor = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const lineStart = getLineStart(value, cursor);
  const lineEnd = value.indexOf("\n", lineStart) === -1 ? value.length : value.indexOf("\n", lineStart);
  const line = value.slice(lineStart, lineEnd);
  let nextLine = line;

  if (line.startsWith("- [ ] ")) {
    nextLine = line.replace("- [ ] ", "- [x] ");
  } else if (line.startsWith("- [x] ") || line.startsWith("- [X] ")) {
    nextLine = line.replace(/- \[[xX]\] /, "- [ ] ");
  } else {
    return;
  }

  event.preventDefault();
  const nextValue = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
  input.value = nextValue;
  input.setSelectionRange(cursor, selectionEnd);
  updateActiveNote({ content: nextValue }, false);
}

function requestImageFiles() {
  const layout = elements.imageLayoutSelect.value;
  elements.imageInput.multiple = layout === "gallery";
  elements.imageInput.click();
}

async function addSelectedImages(event) {
  const files = event.target.files;

  if (!files?.length) {
    return;
  }

  elements.saveStatus.textContent = "이미지 처리 중";

  try {
    const activeNote = getActiveNote();
    const blocks = await createImageBlocksFromFiles(
      files,
      elements.imageLayoutSelect.value,
      elements.imageStyleSelect.value
    );

    if (blocks.length === 0) {
      elements.saveStatus.textContent = "이미지 파일 없음";
      return;
    }

    updateActiveNote({ images: [...(activeNote.images ?? []), ...blocks] });
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "이미지 추가 실패";
  } finally {
    event.target.value = "";
  }
}

elements.newNoteButton.addEventListener("click", () => createNote());
elements.searchInput.addEventListener("input", renderList);
elements.titleInput.addEventListener("input", (event) => {
  updateActiveNote({ title: event.target.value }, false);
});
elements.tagInput.addEventListener("input", (event) => {
  updateActiveNote({ tags: parseTags(event.target.value) }, false);
});
elements.contentInput.addEventListener("input", (event) => {
  updateActiveNote({ content: event.target.value }, false);
});
elements.contentInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    applyFormat("bold");
  }

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    toggleChecklistAtCursor(event);
  }
});
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => applyFormat(button.dataset.action));
});
elements.templateSelect.addEventListener("change", (event) => insertTemplate(event.target.value));
elements.addImageButton.addEventListener("click", requestImageFiles);
elements.imageInput.addEventListener("change", addSelectedImages);
elements.focusButton.addEventListener("click", () => {
  isFocusMode = !isFocusMode;
  elements.appShell.classList.toggle("is-focus-mode", isFocusMode);
  renderEditor();
  elements.contentInput.focus();
});
elements.pinButton.addEventListener("click", () => {
  const note = getActiveNote();
  updateActiveNote({ pinned: !note.pinned });
});
elements.downloadButton.addEventListener("click", downloadActiveNote);
elements.deleteButton.addEventListener("click", deleteActiveNote);
window.addEventListener("beforeunload", () => unsubscribeNotes?.());

render();
connectFirestore();
