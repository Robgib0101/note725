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
} from "./src/text.js";
import { createImageBlocksFromFiles } from "./src/images.js";
import { buildImageFiles, buildTextExport, buildZipBlob, getExportBasename, getNoteImages } from "./src/export.js?v=download-export-1";

let notes = [];
let activeId;
let saveTimer;
let saveRevision = 0;
let notesStore;
let unsubscribeNotes;
let activeCanvasItemId;
let contextMenuItemId;
let contextMenuPoint;
let canvasClipboard;
let canvasToastTimer;
let zCounter = 20;
let miniWindowZ = 90;
let toolPanelMode = "closed";
let toolPanelRestoreMode = "docked";
let toolPanelZ = 86;

const CANVAS_DEFAULTS = {
  textWidth: 520,
  textHeight: 260,
  imageWidth: 320,
  imageHeight: 230,
  minTextWidth: 180,
  minTextHeight: 110,
  minImageWidth: 120,
  minImageHeight: 90,
  maxX: 1600,
  maxY: 1200,
  canvasPadding: 32,
  canvasBottomPadding: 48
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAspectRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? clamp(ratio, 0.25, 4) : undefined;
}

function getImageAspectRatioFromImage(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  return width > 0 && height > 0 ? normalizeAspectRatio(width / height) : undefined;
}

function getImageAspectRatio(item) {
  const explicitRatio = normalizeAspectRatio(item?.aspectRatio);

  if (explicitRatio) {
    return explicitRatio;
  }

  const imageRatio = getImageAspectRatioFromImage(Array.isArray(item?.images) ? item.images[0] : undefined);

  if (imageRatio) {
    return imageRatio;
  }

  const width = normalizeNumber(item?.width, CANVAS_DEFAULTS.imageWidth);
  const height = normalizeNumber(item?.height, CANVAS_DEFAULTS.imageHeight);
  return normalizeAspectRatio(width / height) || CANVAS_DEFAULTS.imageWidth / CANVAS_DEFAULTS.imageHeight;
}

function getDefaultImageSize(image, position = {}) {
  const aspectRatio = normalizeAspectRatio(position.aspectRatio)
    || getImageAspectRatioFromImage(image)
    || CANVAS_DEFAULTS.imageWidth / CANVAS_DEFAULTS.imageHeight;
  const maxWidth = 360;
  const maxHeight = 260;
  let width = clamp(normalizeNumber(position.width, CANVAS_DEFAULTS.imageWidth), CANVAS_DEFAULTS.minImageWidth, maxWidth);
  let height = Math.round(width / aspectRatio);

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * aspectRatio);
  }

  return {
    width: clamp(width, CANVAS_DEFAULTS.minImageWidth, maxWidth),
    height: clamp(height, CANVAS_DEFAULTS.minImageHeight, maxHeight),
    aspectRatio
  };
}

function getCanvasItemFallbackTitle(item) {
  if (item.type === "image") {
    return "이미지";
  }

  return item.text.trim().startsWith("메모") ? "메모" : "텍스트";
}

function normalizeCanvasRestoreGeometry(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return {
    x: normalizeNumber(value.x, 56),
    y: normalizeNumber(value.y, 56),
    width: normalizeNumber(value.width, CANVAS_DEFAULTS.textWidth),
    height: normalizeNumber(value.height, CANVAS_DEFAULTS.textHeight)
  };
}

function normalizeCanvasWindowState(value) {
  return ["normal", "minimized", "maximized"].includes(value) ? value : "normal";
}

function normalizeCanvasItem(item, index = 0) {
  const type = item?.type === "image" ? "image" : "text";
  const minWidth = type === "image" ? CANVAS_DEFAULTS.minImageWidth : CANVAS_DEFAULTS.minTextWidth;
  const minHeight = type === "image" ? CANVAS_DEFAULTS.minImageHeight : CANVAS_DEFAULTS.minTextHeight;
  const fallbackWidth = type === "image" ? CANVAS_DEFAULTS.imageWidth : CANVAS_DEFAULTS.textWidth;
  const aspectRatio = type === "image" ? getImageAspectRatio(item) : undefined;
  const fallbackHeight = type === "image" ? Math.round(fallbackWidth / aspectRatio) : CANVAS_DEFAULTS.textHeight;

  return {
    id: item?.id || createId(),
    type,
    title: item?.title ?? "",
    text: item?.text ?? "",
    images: Array.isArray(item?.images) ? item.images : [],
    caption: item?.caption ?? "",
    note: item?.note ?? "",
    theme: item?.theme || item?.style || "plain",
    crop: item?.crop || "original",
    aspectRatio,
    x: clamp(normalizeNumber(item?.x, 56 + index * 28), 0, CANVAS_DEFAULTS.maxX),
    y: clamp(normalizeNumber(item?.y, 56 + index * 28), 0, CANVAS_DEFAULTS.maxY),
    width: clamp(normalizeNumber(item?.width, fallbackWidth), minWidth, 1200),
    height: clamp(normalizeNumber(item?.height, fallbackHeight), minHeight, 900),
    windowState: normalizeCanvasWindowState(item?.windowState),
    restoreGeometry: normalizeCanvasRestoreGeometry(item?.restoreGeometry),
    locked: Boolean(item?.locked),
    z: normalizeNumber(item?.z, index + 1)
  };
}

function createTextCanvasItem(text = "", position = {}) {
  return normalizeCanvasItem({
    id: createId(),
    type: "text",
    title: position.title ?? "",
    text,
    theme: "plain",
    x: position.x ?? 56,
    y: position.y ?? 56,
    width: position.width ?? CANVAS_DEFAULTS.textWidth,
    height: position.height ?? CANVAS_DEFAULTS.textHeight,
    z: getNextZ()
  });
}

function createImageCanvasItem(image, position = {}, source = {}) {
  const defaultSize = getDefaultImageSize(image, position);

  return normalizeCanvasItem({
    id: createId(),
    type: "image",
    title: source.title ?? position.title ?? "",
    images: [image],
    caption: source.caption ?? "",
    note: source.note ?? "",
    theme: source.theme || source.style || "plain",
    crop: source.crop || "original",
    aspectRatio: defaultSize.aspectRatio,
    x: position.x ?? 80,
    y: position.y ?? 90,
    width: defaultSize.width,
    height: defaultSize.height,
    z: getNextZ()
  });
}

function getNextZ() {
  zCounter += 1;
  return zCounter;
}

function convertLegacyImagesToCanvasItems(images = []) {
  const items = [];

  images.forEach((block, blockIndex) => {
    const blockImages = Array.isArray(block.images) ? block.images : [];
    blockImages.forEach((image, imageIndex) => {
      const offset = blockIndex * 36 + imageIndex * 26;
      items.push(createImageCanvasItem(image, {
        x: 88 + offset,
        y: 340 + offset,
        width: block.width ? clamp(Number(block.width) * 4, CANVAS_DEFAULTS.minImageWidth, 680) : CANVAS_DEFAULTS.imageWidth,
        height: CANVAS_DEFAULTS.imageHeight
      }, block));
    });
  });

  return items;
}

function normalizeNote(note = {}) {
  const now = Date.now();
  const normalizedNote = {
    id: note.id || createId(),
    title: typeof note.title === "string" ? note.title : "",
    content: typeof note.content === "string" ? note.content : "",
    tags: Array.isArray(note.tags) ? note.tags.filter(Boolean).map(String) : [],
    images: Array.isArray(note.images) ? note.images : [],
    canvasItems: Array.isArray(note.canvasItems) ? note.canvasItems : [],
    emptyCanvas: Boolean(note.emptyCanvas),
    pinned: Boolean(note.pinned),
    createdAt: normalizeNumber(note.createdAt, now),
    updatedAt: normalizeNumber(note.updatedAt, now)
  };

  const items = getCanvasItems(normalizedNote);
  normalizedNote.canvasItems = items;
  normalizedNote.content = deriveContentFromCanvasItems(items);
  normalizedNote.images = deriveImagesFromCanvasItems(items);
  return normalizedNote;
}

function initializeNotes() {
  try {
    notes = loadNotes().map(normalizeNote);
  } catch (error) {
    console.error(error);
    notes = [];
  }

  if (notes.length === 0) {
    notes = [normalizeNote({})];
  }

  activeId = notes[0]?.id;
  saveNotes(notes);
}

function getCanvasItems(note) {
  if (!note) {
    return [];
  }

  if (Array.isArray(note.canvasItems) && (note.canvasItems.length > 0 || note.emptyCanvas)) {
    return note.canvasItems.map(normalizeCanvasItem);
  }

  const items = [];
  const content = typeof note.content === "string" ? note.content : "";

  items.push(createTextCanvasItem(content, {
    x: 56,
    y: 56,
    width: CANVAS_DEFAULTS.textWidth,
    height: content.trim() ? CANVAS_DEFAULTS.textHeight : 220
  }));

  items.push(...convertLegacyImagesToCanvasItems(Array.isArray(note.images) ? note.images : []));
  return items;
}

function ensureCanvasItems(note) {
  const items = getCanvasItems(note);

  if (!Array.isArray(note.canvasItems) || (!note.emptyCanvas && note.canvasItems.length === 0)) {
    note.canvasItems = items;
    note.content = deriveContentFromCanvasItems(items);
    note.images = deriveImagesFromCanvasItems(items);
    note.emptyCanvas = items.length === 0;
  }

  zCounter = Math.max(zCounter, ...items.map((item) => item.z ?? 0), 20);
  return items;
}

function deriveContentFromCanvasItems(items) {
  return items
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function deriveImagesFromCanvasItems(items) {
  return items
    .filter((item) => item.type === "image" && item.images.length > 0)
    .map((item) => ({
      id: item.id,
      layout: "free",
      style: item.theme === "plain" ? "clean" : item.theme,
      crop: item.crop,
      title: item.title,
      width: Math.round(item.width),
      height: Math.round(item.height),
      aspectRatio: item.aspectRatio,
      restoreGeometry: item.restoreGeometry,
      windowState: item.windowState,
      locked: item.locked,
      x: Math.round(item.x),
      y: Math.round(item.y),
      caption: item.caption,
      note: item.note,
      images: item.images
    }));
}

function buildCanvasPatch(items) {
  const normalizedItems = items.map(normalizeCanvasItem);

  return {
    canvasItems: normalizedItems,
    emptyCanvas: normalizedItems.length === 0,
    content: deriveContentFromCanvasItems(normalizedItems),
    images: deriveImagesFromCanvasItems(normalizedItems)
  };
}

function syncCanvasItems(items, shouldRender = false) {
  updateActiveNote(buildCanvasPatch(items), false);

  if (shouldRender) {
    renderCanvasForActiveNote();
  }
}

function updateCanvasItem(itemId, patch, shouldRender = false) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote).map((item) => (
    item.id === itemId ? normalizeCanvasItem({ ...item, ...patch }) : item
  ));

  syncCanvasItems(items, shouldRender);
}

function restoreCanvasItem(item, index = 0) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote).filter((canvasItem) => canvasItem.id !== item.id);
  const nextItems = [...items];
  nextItems.splice(clamp(index, 0, nextItems.length), 0, normalizeCanvasItem(item));
  activeCanvasItemId = item.id;
  syncCanvasItems(nextItems, true);
}

function removeCanvasItem(itemId, options = {}) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);
  const removedIndex = items.findIndex((item) => item.id === itemId);

  if (removedIndex < 0) {
    return;
  }

  const removedItem = items[removedIndex];
  const nextItems = items.filter((item) => item.id !== itemId);

  if (activeCanvasItemId === itemId) {
    activeCanvasItemId = nextItems[0]?.id;
  }

  hideCanvasContextMenu();
  hideCanvasCloseMenu();
  syncCanvasItems(nextItems, true);

  if (options.undo) {
    showCanvasToast("박스를 삭제했습니다", [
      { label: "되돌리기", action: () => restoreCanvasItem(removedItem, removedIndex) }
    ]);
  }
}

function duplicateCanvasItem(itemId) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);
  const item = items.find((canvasItem) => canvasItem.id === itemId);

  if (!item) {
    return;
  }

  const duplicate = normalizeCanvasItem({
    ...item,
    id: createId(),
    x: clamp(item.x + 28, 0, CANVAS_DEFAULTS.maxX),
    y: clamp(item.y + 28, 0, CANVAS_DEFAULTS.maxY),
    windowState: "normal",
    z: getNextZ()
  });

  activeCanvasItemId = duplicate.id;
  hideCanvasContextMenu();
  syncCanvasItems([...items, duplicate], true);
}

function addCanvasText(text = "", position = {}) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);
  const item = createTextCanvasItem(text, position);

  activeCanvasItemId = item.id;
  syncCanvasItems([...items, item], true);
  requestAnimationFrame(() => focusCanvasTextItem(item.id));
}

function addCanvasImages(blocks, origin = {}) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);
  const nextImageItems = [];
  const startX = origin.x ?? 90;
  const startY = origin.y ?? 120;
  let offset = origin.x === undefined ? items.length * 18 : 0;

  blocks.forEach((block) => {
    const images = Array.isArray(block.images) ? block.images : [];
    images.forEach((image) => {
      nextImageItems.push(createImageCanvasItem(image, {
        x: startX + offset,
        y: startY + offset
      }, block));
      offset += 26;
    });
  });

  if (nextImageItems.length === 0) {
    return;
  }

  activeCanvasItemId = nextImageItems[0].id;
  syncCanvasItems([...items, ...nextImageItems], true);
}

function activateCanvasItem(itemId) {
  activeCanvasItemId = itemId;
  elements.memoCanvas.querySelectorAll(".canvas-item.is-active").forEach((item) => {
    item.classList.remove("is-active");
  });
  elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]')?.classList.add("is-active");
}

function getActiveCanvasItems() {
  return ensureCanvasItems(getActiveNote());
}

function getActiveTextItem() {
  const items = getActiveCanvasItems();
  const activeItem = items.find((item) => item.id === activeCanvasItemId && item.type === "text");

  return activeItem ?? items.find((item) => item.type === "text");
}

function getActiveTextElement() {
  const item = getActiveTextItem();

  if (!item) {
    return null;
  }

  return elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(item.id) + '"] .canvas-text-content');
}

function focusCanvasTextItem(itemId) {
  const editable = elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(itemId) + '"] .canvas-text-content');

  if (!editable) {
    return;
  }

  activateCanvasItem(itemId);
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function getCanvasViewportSize() {
  const wrap = elements.memoCanvas.parentElement;

  return {
    width: Math.max(320, wrap?.clientWidth || elements.memoCanvas.clientWidth || 720),
    height: Math.max(360, wrap?.clientHeight || elements.memoCanvas.clientHeight || 520)
  };
}

function getCanvasContentBounds(items) {
  const visibleItems = items.filter((item) => item.windowState !== "minimized");

  if (visibleItems.length === 0) {
    return { right: 0, bottom: 0 };
  }

  return visibleItems.reduce((bounds, item) => ({
    right: Math.max(bounds.right, item.x + item.width),
    bottom: Math.max(bounds.bottom, item.y + item.height)
  }), { right: 0, bottom: 0 });
}

function resizeCanvasToContent(items = getActiveCanvasItems()) {
  const viewport = getCanvasViewportSize();
  const bounds = getCanvasContentBounds(items);
  const nextWidth = Math.max(viewport.width, Math.ceil(bounds.right + CANVAS_DEFAULTS.canvasPadding));
  const nextHeight = Math.max(viewport.height, Math.ceil(bounds.bottom + CANVAS_DEFAULTS.canvasBottomPadding));

  elements.memoCanvas.style.width = nextWidth + "px";
  elements.memoCanvas.style.height = nextHeight + "px";
}

function renderCanvasForActiveNote() {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);

  elements.memoCanvas.innerHTML = "";
  elements.contentInput.value = deriveContentFromCanvasItems(items);

  items.forEach((item) => {
    elements.memoCanvas.append(createCanvasElement(item));
  });

  resizeCanvasToContent(items);

  if (!items.some((item) => item.id === activeCanvasItemId)) {
    activeCanvasItemId = items.find((item) => item.type === "text")?.id ?? items[0]?.id;
  }

  if (activeCanvasItemId) {
    activateCanvasItem(activeCanvasItemId);
  }
}


function getPanelWindowTitle(target) {
  return target.dataset.windowTitle || target.getAttribute("aria-label") || "창";
}

function createWindowControl(action, label, symbol) {
  const button = document.createElement("button");
  button.className = "window-control window-control--" + action;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.windowAction = action;
  button.textContent = symbol;
  return button;
}

function bringPanelWindowToFront(target) {
  if (target.dataset.windowFloating === "true") {
    return;
  }

  target.style.zIndex = String(++panelWindowZ);
}

function updateWindowDock() {
  if (!elements.windowDock) {
    return;
  }

  const dockedWindows = [...document.querySelectorAll("[data-window].window-frame")]
    .filter((target) => target.dataset.windowFloating !== "true")
    .filter((target) => target.classList.contains("is-window-closed") || target.classList.contains("is-window-minimized"));

  elements.windowDock.innerHTML = "";
  elements.windowDock.hidden = dockedWindows.length === 0;

  dockedWindows.forEach((target) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "window-dock-button";
    button.textContent = getPanelWindowTitle(target);
    button.title = getPanelWindowTitle(target) + " 복원";
    button.addEventListener("click", () => {
      target.classList.remove("is-window-closed", "is-window-minimized");
      bringPanelWindowToFront(target);
      updateWindowDock();
    });
    elements.windowDock.append(button);
  });
}

function setPanelWindowOffset(target, x, y) {
  target.dataset.windowX = String(x);
  target.dataset.windowY = String(y);
  target.style.setProperty("--window-x", x + "px");
  target.style.setProperty("--window-y", y + "px");
}

function startPanelWindowDrag(event, target) {
  if (target.classList.contains("is-window-maximized") || target.classList.contains("is-window-closed")) {
    return;
  }

  event.preventDefault();
  bringPanelWindowToFront(target);

  const startX = event.clientX;
  const startY = event.clientY;
  const startOffsetX = Number(target.dataset.windowX || 0);
  const startOffsetY = Number(target.dataset.windowY || 0);
  const maxX = Math.max(96, elements.appShell.clientWidth * 0.32);
  const maxY = Math.max(80, elements.appShell.clientHeight * 0.24);

  function handleMove(moveEvent) {
    const nextX = clamp(startOffsetX + moveEvent.clientX - startX, -maxX, maxX);
    const nextY = clamp(startOffsetY + moveEvent.clientY - startY, -maxY, maxY);
    setPanelWindowOffset(target, Math.round(nextX), Math.round(nextY));
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function startPanelWindowResize(event, target) {
  if (target.classList.contains("is-window-maximized") || target.classList.contains("is-window-minimized")) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  bringPanelWindowToFront(target);

  const startX = event.clientX;
  const startY = event.clientY;
  const startWidth = target.offsetWidth;
  const startHeight = target.offsetHeight;
  const maxWidth = Math.max(startWidth, elements.appShell.clientWidth - 28);
  const maxHeight = Math.max(startHeight, elements.appShell.clientHeight - 28);

  function handleMove(moveEvent) {
    const nextWidth = clamp(startWidth + moveEvent.clientX - startX, 220, maxWidth);
    const nextHeight = clamp(startHeight + moveEvent.clientY - startY, 120, maxHeight);
    target.style.width = Math.round(nextWidth) + "px";
    target.style.height = Math.round(nextHeight) + "px";
    target.classList.add("has-custom-window-size");
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function handlePanelWindowAction(action, target, button) {
  if (action === "minimize") {
    if (target.dataset.windowFloating === "true") {
      target.hidden = true;
      return;
    }

    target.classList.toggle("is-window-minimized");
    button.setAttribute("aria-pressed", String(target.classList.contains("is-window-minimized")));
    updateWindowDock();
    return;
  }

  if (action === "maximize") {
    if (target.dataset.windowFloating === "true") {
      return;
    }

    target.classList.toggle("is-window-maximized");
    button.textContent = target.classList.contains("is-window-maximized") ? "❐" : "□";
    button.title = target.classList.contains("is-window-maximized") ? "복원" : "최대화";
    button.setAttribute("aria-label", button.title);
    bringPanelWindowToFront(target);
    return;
  }

  if (action === "close") {
    if (target.dataset.windowFloating === "true") {
      hideCanvasContextMenu();
      return;
    }

    target.classList.remove("is-window-minimized", "is-window-maximized");
    target.classList.add("is-window-closed");
    updateWindowDock();
  }
}

function setupPanelWindows() {
  document.querySelectorAll("[data-window]").forEach((target) => {
    if (target.classList.contains("window-frame")) {
      return;
    }

    target.classList.add("window-frame");
    target.style.setProperty("--window-x", "0px");
    target.style.setProperty("--window-y", "0px");

    const titlebar = document.createElement("div");
    titlebar.className = "window-titlebar";

    const title = document.createElement("span");
    title.className = "window-title";
    title.textContent = getPanelWindowTitle(target);

    const controls = document.createElement("span");
    controls.className = "window-controls";

    const actions = target.dataset.windowFloating === "true"
      ? [["close", "닫기", "×"]]
      : [["minimize", "최소화", "−"], ["maximize", "최대화", "□"], ["close", "닫기", "×"]];

    actions.forEach(([action, label, symbol]) => {
      const button = createWindowControl(action, label, symbol);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handlePanelWindowAction(action, target, button);
      });
      controls.append(button);
    });

    titlebar.append(title, controls);
    titlebar.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) {
        return;
      }

      startPanelWindowDrag(event, target);
    });

    target.prepend(titlebar);
    target.addEventListener("pointerdown", () => bringPanelWindowToFront(target));

    if (target.dataset.windowFloating !== "true") {
      const resizer = document.createElement("div");
      resizer.className = "window-resizer";
      resizer.title = "창 크기 조절";
      resizer.addEventListener("pointerdown", (event) => startPanelWindowResize(event, target));
      target.append(resizer);
    }
  });

  updateWindowDock();
}

function createCanvasWindowButton(action, label, symbol) {
  const button = document.createElement("button");
  button.className = "canvas-window-button canvas-window-button--" + action;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = symbol;
  return button;
}

function toggleCanvasMinimize(item, element, button) {
  const minimized = !element.classList.contains("is-canvas-minimized");
  element.classList.toggle("is-canvas-minimized", minimized);
  button.textContent = minimized ? "+" : "−";
  button.title = minimized ? "보이기" : "숨기기";
  button.setAttribute("aria-label", button.title);
  updateCanvasItem(item.id, { windowState: minimized ? "minimized" : "normal" }, false);
}

function restoreCanvasMaximize(item) {
  const restore = item.restoreGeometry;

  if (!restore) {
    updateCanvasItem(item.id, { windowState: "normal", restoreGeometry: undefined }, true);
    return;
  }

  updateCanvasItem(item.id, {
    x: restore.x,
    y: restore.y,
    width: restore.width,
    height: restore.height,
    windowState: "normal",
    restoreGeometry: undefined,
    z: getNextZ()
  }, true);
}

function toggleCanvasMaximize(item) {
  if (item.windowState === "maximized") {
    restoreCanvasMaximize(item);
    return;
  }

  const wrap = elements.memoCanvas.parentElement;
  const nextWidth = clamp((wrap?.clientWidth || 720) - 36, item.type === "image" ? 320 : 440, 1120);
  const nextHeight = clamp((wrap?.clientHeight || 520) - 36, item.type === "image" ? 260 : 300, 820);

  updateCanvasItem(item.id, {
    x: (wrap?.scrollLeft || 0) + 18,
    y: (wrap?.scrollTop || 0) + 18,
    width: nextWidth,
    height: nextHeight,
    windowState: "maximized",
    restoreGeometry: {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    },
    z: getNextZ()
  }, true);
}

function createCanvasItemTitlebar(item, element) {
  const grip = document.createElement("div");
  grip.className = "canvas-item-grip";
  grip.title = "상단을 드래그해서 이동";

  const dragHandle = document.createElement("button");
  dragHandle.className = "canvas-drag-handle";
  dragHandle.type = "button";
  dragHandle.title = "드래그해서 이동";
  dragHandle.setAttribute("aria-label", "드래그해서 이동");
  dragHandle.textContent = "⋮⋮";
  dragHandle.addEventListener("pointerdown", (event) => startCanvasDrag(event, item, element));

  const title = document.createElement("input");
  title.className = "canvas-title-input";
  title.type = "text";
  title.value = item.title;
  title.placeholder = getCanvasItemFallbackTitle(item);
  title.setAttribute("aria-label", "박스 제목");
  title.addEventListener("focus", () => activateCanvasItem(item.id));
  title.addEventListener("pointerdown", (event) => event.stopPropagation());
  title.addEventListener("input", (event) => {
    updateCanvasItem(item.id, { title: event.target.value }, false);
  });

  const controls = document.createElement("span");
  controls.className = "canvas-window-controls";

  const hideButton = createCanvasWindowButton(
    "minimize",
    item.windowState === "minimized" ? "펼치기" : "접기",
    item.windowState === "minimized" ? "+" : "−"
  );
  hideButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCanvasMinimize(item, element, hideButton);
  });

  const maximizeButton = createCanvasWindowButton(
    "maximize",
    item.windowState === "maximized" ? "복원" : "최대화",
    item.windowState === "maximized" ? "❐" : "□"
  );
  maximizeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCanvasMaximize(item);
  });

  const deleteButton = createCanvasWindowButton("close", "닫기", "×");
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showCanvasCloseMenu(event, item.id);
  });

  controls.append(hideButton, maximizeButton, deleteButton);
  grip.append(dragHandle, title, controls);
  grip.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input")) {
      return;
    }

    startCanvasDrag(event, item, element);
  });

  return grip;
}


const MINI_APPS = {
  tools: { title: "도구 패널", y: 92, width: 300 },
  images: { title: "이미지 보관함", y: 120, width: 340 },
  templates: { title: "템플릿", y: 148, width: 300 },
  files: { title: "파일", y: 176, width: 310 },
  stickers: { title: "스티커", y: 204, width: 300 },
  settings: { title: "설정", y: 232, width: 320 }
};

function getMiniWindow(appId) {
  return elements.miniWindowLayer?.querySelector('[data-mini-window="' + CSS.escape(appId) + '"]');
}

function bringMiniWindowToFront(windowElement) {
  windowElement.style.zIndex = String(++miniWindowZ);
}

function getMiniAppButton(appId) {
  return document.querySelector(`[data-open-app="${CSS.escape(appId)}"]`);
}

function getToolPanelPosition() {
  const workspace = elements.editorWorkspace || elements.appShell;
  const panelWidth = Math.min(320, Math.max(260, (workspace?.clientWidth || 1180) * 0.28));
  const x = clamp((workspace?.clientWidth || 1180) - panelWidth - 88, 12, Math.max(12, (workspace?.clientWidth || 1180) - panelWidth - 12));
  const y = 14;

  return { x, y };
}

function setToolPanelPosition(x, y) {
  const workspace = elements.editorWorkspace || elements.appShell;
  const panel = elements.writingTools;

  if (!panel || !workspace) {
    return;
  }

  const maxX = Math.max(12, workspace.clientWidth - panel.offsetWidth - 12);
  const maxY = Math.max(12, workspace.clientHeight - Math.min(panel.offsetHeight, workspace.clientHeight - 24) - 12);
  const nextX = Math.round(clamp(x, 12, maxX));
  const nextY = Math.round(clamp(y, 12, maxY));

  panel.dataset.panelX = String(nextX);
  panel.dataset.panelY = String(nextY);
  panel.style.left = nextX + "px";
  panel.style.top = nextY + "px";
}

function updateToolPanelControls() {
  const isDocked = toolPanelMode === "docked";
  const isMinimized = toolPanelMode === "minimized";

  if (elements.toolPanelFloatButton) {
    elements.toolPanelFloatButton.textContent = isDocked ? "↗" : "▣";
    elements.toolPanelFloatButton.title = isDocked ? "창으로 띄우기" : "오른쪽에 고정";
    elements.toolPanelFloatButton.setAttribute("aria-label", elements.toolPanelFloatButton.title);
  }

  if (elements.toolPanelMinimizeButton) {
    elements.toolPanelMinimizeButton.textContent = isMinimized ? "▣" : "−";
    elements.toolPanelMinimizeButton.title = isMinimized ? "복원" : "최소화";
    elements.toolPanelMinimizeButton.setAttribute("aria-label", elements.toolPanelMinimizeButton.title);
  }
}

function setToolPanelMode(mode) {
  const panel = elements.writingTools;

  if (!panel || !elements.editorWorkspace) {
    return;
  }

  if (mode === "docked" || mode === "floating") {
    toolPanelRestoreMode = mode;
  }

  toolPanelMode = mode;
  panel.dataset.panelState = mode;
  panel.hidden = mode === "closed";
  panel.classList.toggle("is-tools-floating", mode === "floating" || mode === "minimized");
  panel.classList.toggle("is-tools-minimized", mode === "minimized");
  elements.editorWorkspace.classList.toggle("is-tools-collapsed", mode !== "docked");
  elements.editorWorkspace.classList.toggle("is-tools-minimized", mode === "minimized");
  elements.editorWorkspace.classList.toggle("is-tools-closed", mode === "closed");
  elements.appShell.classList.toggle("has-docked-tools", mode === "docked");
  elements.appShell.classList.toggle("has-floating-tools", mode === "floating");
  elements.appShell.classList.toggle("has-minimized-tools", mode === "minimized");
  elements.appShell.classList.toggle("has-closed-tools", mode === "closed");

  if (mode === "docked" || mode === "closed") {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.zIndex = "";
  } else {
    const fallback = getToolPanelPosition();
    const x = Number(panel.dataset.panelX || fallback.x);
    const y = Number(panel.dataset.panelY || fallback.y);
    panel.style.zIndex = String(++toolPanelZ);
    setToolPanelPosition(x, y);
  }

  updateToolPanelControls();
  updateMiniAppButtonState("tools");
}

function restoreToolPanel() {
  setToolPanelMode(toolPanelRestoreMode || "docked");
}

function toggleToolPanelFloat() {
  if (toolPanelMode === "docked") {
    setToolPanelMode("floating");
    return;
  }

  setToolPanelMode("closed");
}

function startToolPanelDrag(event) {
  if (event.target.closest("button")) {
    return;
  }

  event.preventDefault();

  if (toolPanelMode === "docked" || toolPanelMode === "closed") {
    setToolPanelMode("floating");
  }

  const panel = elements.writingTools;
  if (!panel) {
    return;
  }

  panel.style.zIndex = String(++toolPanelZ);
  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = Number(panel.dataset.panelX || 12);
  const startTop = Number(panel.dataset.panelY || 12);

  function handleMove(moveEvent) {
    setToolPanelPosition(startLeft + moveEvent.clientX - startX, startTop + moveEvent.clientY - startY);
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function setupToolPanel() {
  if (!elements.writingTools) {
    return;
  }

  elements.toolPanelTitlebar?.addEventListener("pointerdown", startToolPanelDrag);
  elements.toolPanelFloatButton?.addEventListener("click", toggleToolPanelFloat);
  elements.toolPanelMinimizeButton?.addEventListener("click", () => {
    if (toolPanelMode === "minimized") {
      restoreToolPanel();
      return;
    }

    toolPanelRestoreMode = toolPanelMode === "floating" ? "floating" : "docked";
    setToolPanelMode("minimized");
  });
  elements.toolPanelCloseButton?.addEventListener("click", () => {
    if (toolPanelMode === "floating" || toolPanelMode === "docked") {
      toolPanelRestoreMode = toolPanelMode;
    }

    setToolPanelMode("closed");
  });
  setToolPanelMode("closed");
}

function updateMiniAppButtonState(appId) {
  const button = getMiniAppButton(appId);

  if (!button) {
    return;
  }

  if (appId === "tools" && elements.writingTools) {
    const isVisible = !elements.writingTools.hidden;
    const isMinimized = toolPanelMode === "minimized";
    button.classList.toggle("is-open", isVisible && !isMinimized);
    button.classList.toggle("is-minimized", isMinimized);
    button.setAttribute("aria-pressed", String(button.classList.contains("is-selected") || isVisible));
    return;
  }

  const windowElement = getMiniWindow(appId);
  const isVisible = Boolean(windowElement && !windowElement.hidden);
  const isMinimized = windowElement?.dataset.windowState === "minimized";
  button.classList.toggle("is-open", isVisible);
  button.classList.toggle("is-minimized", !isVisible && isMinimized);
  button.setAttribute("aria-pressed", String(button.classList.contains("is-selected") || isVisible));
}

function setMiniWindowVisibility(windowElement, state) {
  windowElement.dataset.windowState = state;
  windowElement.hidden = state !== "open";
  updateMiniAppButtonState(windowElement.dataset.miniWindow);
}

function getMiniWindowPosition(config) {
  const shellWidth = elements.appShell?.clientWidth || 1180;
  const launcherWidth = document.querySelector(".app-launcher")?.offsetWidth || 70;
  const gutter = shellWidth > 760 ? launcherWidth + 28 : 12;
  const x = clamp(shellWidth - config.width - gutter, 18, Math.max(18, shellWidth - config.width - 18));
  const y = clamp(config.y, 18, Math.max(18, (elements.appShell?.clientHeight || 720) - 230));

  return { x, y };
}

function createMiniWindowButton(action, label, symbol) {
  const button = document.createElement("button");
  button.className = "mini-window-control mini-window-control--" + action;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = symbol;
  return button;
}

function startMiniWindowDrag(event, windowElement) {
  event.preventDefault();
  bringMiniWindowToFront(windowElement);

  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = Number(windowElement.dataset.windowX || 0);
  const startTop = Number(windowElement.dataset.windowY || 0);
  const bounds = elements.appShell.getBoundingClientRect();

  function handleMove(moveEvent) {
    const width = windowElement.offsetWidth;
    const height = windowElement.offsetHeight;
    const nextX = clamp(startLeft + moveEvent.clientX - startX, 10, Math.max(10, bounds.width - width - 10));
    const nextY = clamp(startTop + moveEvent.clientY - startY, 10, Math.max(10, bounds.height - height - 10));
    windowElement.dataset.windowX = String(Math.round(nextX));
    windowElement.dataset.windowY = String(Math.round(nextY));
    windowElement.style.left = Math.round(nextX) + "px";
    windowElement.style.top = Math.round(nextY) + "px";
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function startMiniWindowResize(event, windowElement) {
  event.preventDefault();
  event.stopPropagation();
  bringMiniWindowToFront(windowElement);

  const startX = event.clientX;
  const startY = event.clientY;
  const startWidth = windowElement.offsetWidth;
  const startHeight = windowElement.offsetHeight;

  function handleMove(moveEvent) {
    windowElement.style.width = clamp(startWidth + moveEvent.clientX - startX, 240, 520) + "px";
    windowElement.style.minHeight = clamp(startHeight + moveEvent.clientY - startY, 160, 620) + "px";
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function createMiniWindow(appId) {
  const config = MINI_APPS[appId];
  if (!config || !elements.miniWindowLayer) {
    return null;
  }

  const windowElement = document.createElement("section");
  const position = getMiniWindowPosition(config);
  windowElement.className = "mini-app-window";
  windowElement.dataset.miniWindow = appId;
  windowElement.dataset.windowState = "closed";
  windowElement.dataset.windowX = String(position.x);
  windowElement.dataset.windowY = String(position.y);
  windowElement.style.left = position.x + "px";
  windowElement.style.top = position.y + "px";
  windowElement.style.width = config.width + "px";
  windowElement.hidden = true;
  windowElement.setAttribute("aria-label", config.title);

  const titlebar = document.createElement("div");
  titlebar.className = "mini-window-titlebar";
  titlebar.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("button")) {
      startMiniWindowDrag(event, windowElement);
    }
  });

  const title = document.createElement("span");
  title.className = "mini-window-title";
  title.textContent = config.title;

  const controls = document.createElement("span");
  controls.className = "mini-window-controls";
  const minimizeButton = createMiniWindowButton("minimize", "최소화", "−");
  minimizeButton.addEventListener("click", () => {
    setMiniWindowVisibility(windowElement, "minimized");
  });
  const closeButton = createMiniWindowButton("close", "닫기", "×");
  closeButton.addEventListener("click", () => {
    setMiniWindowVisibility(windowElement, "closed");
  });
  controls.append(minimizeButton, closeButton);
  titlebar.append(title, controls);

  const body = document.createElement("div");
  body.className = "mini-window-body";

  const resizer = document.createElement("div");
  resizer.className = "mini-window-resizer";
  resizer.title = "창 크기 조절";
  resizer.addEventListener("pointerdown", (event) => startMiniWindowResize(event, windowElement));

  windowElement.append(titlebar, body, resizer);
  windowElement.addEventListener("pointerdown", () => bringMiniWindowToFront(windowElement));
  elements.miniWindowLayer.append(windowElement);
  return windowElement;
}

function miniAppIsOpen(appId) {
  if (appId === "tools") {
    return elements.writingTools && !elements.writingTools.hidden && toolPanelMode !== "minimized";
  }

  const windowElement = getMiniWindow(appId);
  return Boolean(windowElement && !windowElement.hidden && windowElement.dataset.windowState === "open");
}

function closeMiniApp(appId) {
  if (appId === "tools") {
    setToolPanelMode("closed");
    return;
  }

  const windowElement = getMiniWindow(appId);
  if (windowElement) {
    setMiniWindowVisibility(windowElement, "closed");
  }
}

function openMiniApp(appId) {
  if (appId === "tools") {
    restoreToolPanel();
    return;
  }

  let windowElement = getMiniWindow(appId) || createMiniWindow(appId);
  if (!windowElement) {
    return;
  }

  renderMiniApp(appId, windowElement.querySelector(".mini-window-body"));
  setMiniWindowVisibility(windowElement, "open");
  bringMiniWindowToFront(windowElement);
}

function createMiniButton(label, action, className = "mini-command") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function createMiniGroupTitle(label) {
  const title = document.createElement("span");
  title.className = "mini-settings-title";
  title.textContent = label;
  return title;
}

function getSettingsStatusText() {
  const note = getActiveNote();
  const items = getCanvasItems(note);
  const hiddenCount = items.filter((item) => item.windowState === "minimized").length;
  const storageLabel = notesStore?.enabled ? "Firebase 연결" : "로컬 저장";
  return storageLabel + " · 메모 " + notes.length + "개 · 박스 " + items.length + "개 · 숨김 " + hiddenCount + "개";
}

function clearActiveNoteContent() {
  const note = getActiveNote();

  if (!note) {
    return;
  }

  activeCanvasItemId = undefined;
  updateActiveNote({
    title: "",
    content: "",
    tags: [],
    images: [],
    canvasItems: [],
    emptyCanvas: true
  });
  elements.saveStatus.textContent = "메모를 비웠습니다";
}

function showAllCanvasItems() {
  const items = getActiveCanvasItems().map((item) => ({
    ...item,
    windowState: item.windowState === "minimized" ? "normal" : item.windowState
  }));
  syncCanvasItems(items, true);
}

function arrangeCanvasItems() {
  const items = getActiveCanvasItems().map((item, index) => normalizeCanvasItem({
    ...item,
    x: 40 + (index % 2) * 34,
    y: 40 + index * 34,
    windowState: item.windowState === "minimized" ? "normal" : item.windowState,
    z: index + 1
  }));

  zCounter = Math.max(20, items.length + 1);
  syncCanvasItems(items, true);
  resizeCanvasToContent(items);
}

function renderMiniApp(appId, body) {
  body.innerHTML = "";

  if (appId === "tools") {
    const grid = document.createElement("div");
    grid.className = "mini-command-grid";
    grid.append(
      createMiniButton("텍스트 블록", () => addCanvasText("")),
      createMiniButton("이미지 추가", requestImageFiles),
      createMiniButton("TXT 불러오기", requestTextFile),
      createMiniButton("날짜 삽입", () => applyFormat("date")),
      createMiniButton("메모 다운로드", downloadActiveNote)
    );
    body.append(grid);
    return;
  }

  if (appId === "images") {
    const note = getActiveNote();
    const items = getCanvasItems(note).filter((item) => item.type === "image");
    const summary = document.createElement("p");
    summary.className = "mini-window-note";
    summary.textContent = items.length ? "현재 메모의 이미지 " + items.length + "개" : "아직 이미지가 없습니다.";
    body.append(summary, createMiniButton("이미지 추가", requestImageFiles));

    const list = document.createElement("div");
    list.className = "mini-image-list";
    items.slice(0, 6).forEach((item, index) => {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "mini-image-thumb";
      const image = item.images[0];

      if (image?.src) {
        const img = document.createElement("img");
        img.src = image.src;
        img.alt = image.name || "첨부 이미지";
        thumb.append(img);
      }

      const label = document.createElement("span");
      label.textContent = item.title || item.caption || image?.name || "이미지 " + (index + 1);
      thumb.append(label);
      thumb.addEventListener("click", () => focusCanvasItem(item.id));
      list.append(thumb);
    });
    body.append(list);
    return;
  }

  if (appId === "templates") {
    const list = document.createElement("div");
    list.className = "mini-command-list";
    [
      ["오늘 기록", "daily"],
      ["회의록", "meeting"],
      ["아이디어", "idea"],
      ["작업 목록", "tasks"]
    ].forEach(([label, value]) => {
      list.append(createMiniButton(label, () => insertTemplate(value)));
    });
    body.append(list);
    return;
  }

  if (appId === "files") {
    const list = document.createElement("div");
    list.className = "mini-command-list";
    list.append(
      createMiniButton("새 메모", () => createNote()),
      createMiniButton("TXT 불러오기", requestTextFile),
      createMiniButton("메모 다운로드", downloadActiveNote)
    );
    body.append(list);
    return;
  }

  if (appId === "stickers") {
    const list = document.createElement("div");
    list.className = "mini-sticker-grid";
    [
      ["중요", "중요:\n"],
      ["아이디어", "아이디어:\n"],
      ["할 일", "할 일:\n- [ ] "],
      ["메모", "메모:\n"]
    ].forEach(([label, text]) => {
      list.append(createMiniButton(label, () => addCanvasText(text, {
        x: 96 + getActiveCanvasItems().length * 18,
        y: 96 + getActiveCanvasItems().length * 18,
        width: 260,
        height: 160
      }), "mini-sticker-button"));
    });
    body.append(list);
    return;
  }

  if (appId === "settings") {
    const note = getActiveNote();
    const summary = document.createElement("p");
    summary.className = "mini-window-note";
    summary.textContent = getSettingsStatusText();

    const noteGroup = document.createElement("div");
    noteGroup.className = "mini-settings-group";
    noteGroup.append(createMiniGroupTitle("현재 메모"));
    noteGroup.append(
      createMiniButton(note?.pinned ? "고정 해제" : "메모 고정", () => {
        elements.pinButton.click();
        renderMiniApp(appId, body);
      }),
      createMiniButton("새 메모", () => createNote()),
      createMiniButton("메모 다운로드", downloadActiveNote),
      createMiniButton("메모 비우기", () => clearActiveNoteContent())
    );

    const canvasGroup = document.createElement("div");
    canvasGroup.className = "mini-settings-group";
    canvasGroup.append(createMiniGroupTitle("캔버스"));
    canvasGroup.append(
      createMiniButton("숨긴 박스 모두 표시", showAllCanvasItems),
      createMiniButton("박스 정렬", arrangeCanvasItems),
      createMiniButton("캔버스 크기 맞춤", () => resizeCanvasToContent(getActiveCanvasItems()))
    );

    const appGroup = document.createElement("div");
    appGroup.className = "mini-settings-group";
    appGroup.append(createMiniGroupTitle("앱 상태"));
    appGroup.append(
      createMiniButton("저장 상태 갱신", () => {
        summary.textContent = getSettingsStatusText();
        elements.saveStatus.textContent = notesStore?.enabled ? "Firebase 저장됨" : "로컬 저장됨";
      }),
      createMiniButton("도구 패널 닫기", () => setToolPanelMode("closed")),
      createMiniButton("화면 새로고침", () => window.location.reload())
    );

    body.append(summary, noteGroup, canvasGroup, appGroup);
    return;
  }
}

function focusCanvasItem(itemId) {
  const itemElement = elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]');
  if (!itemElement) {
    return;
  }

  activateCanvasItem(itemId);
  itemElement.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
}

function setupMiniApps() {
  document.querySelectorAll("[data-open-app]").forEach((button) => {
    button.addEventListener("click", () => {
      const appId = button.dataset.openApp;
      const shouldClose = miniAppIsOpen(appId);

      document.querySelectorAll(".app-icon").forEach((item) => item.classList.remove("is-selected"));

      if (shouldClose) {
        closeMiniApp(appId);
      } else {
        button.classList.add("is-selected");
        openMiniApp(appId);
      }

      document.querySelectorAll("[data-open-app]").forEach((item) => updateMiniAppButtonState(item.dataset.openApp));
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        button.click();
      }
    });
  });
}

function createCanvasElement(item) {
  const element = document.createElement("article");
  element.className = "canvas-item canvas-item--" + item.type + " canvas-theme--" + item.theme + " canvas-crop--" + item.crop;
  element.dataset.itemId = item.id;
  element.dataset.itemType = item.type;
  element.classList.toggle("is-canvas-locked", item.locked);
  element.style.left = item.x + "px";
  element.style.top = item.y + "px";
  element.style.width = item.width + "px";
  element.style.zIndex = String(item.z);
  element.tabIndex = 0;
  element.classList.toggle("is-canvas-minimized", item.windowState === "minimized");
  element.classList.toggle("is-canvas-maximized", item.windowState === "maximized");
  element.style.height = item.height + "px";

  const titlebar = createCanvasItemTitlebar(item, element);
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "canvas-resize-handle";
  resizeHandle.title = "드래그해서 크기 변경";
  resizeHandle.addEventListener("pointerdown", (event) => startCanvasResize(event, item, element));

  element.addEventListener("pointerdown", () => activateCanvasItem(item.id));
  element.addEventListener("contextmenu", (event) => showCanvasContextMenu(event, item.id));

  if (item.type === "image") {
    element.append(titlebar, createCanvasImageBody(item), resizeHandle);
  } else {
    element.append(titlebar, createCanvasTextBody(item), resizeHandle);
  }

  return element;
}


function createCanvasTextBody(item) {
  const body = document.createElement("div");
  body.className = "canvas-text-content";
  body.contentEditable = "true";
  body.spellcheck = true;
  body.textContent = item.text;
  body.addEventListener("focus", () => activateCanvasItem(item.id));
  body.addEventListener("input", () => {
    updateCanvasItem(item.id, { text: body.innerText.replace(/ /g, " ") }, false);
  });
  body.addEventListener("keydown", handleCanvasTextKeydown);
  return body;
}

function createCanvasImageBody(item) {
  const body = document.createElement("div");
  body.className = "canvas-image-body";

  item.images.forEach((image) => {
    const img = document.createElement("img");
    img.src = image.src;
    img.alt = image.name || "첨부 이미지";
    img.draggable = false;
    body.append(img);
  });

  const caption = document.createElement("input");
  caption.className = "canvas-image-caption";
  caption.type = "text";
  caption.value = item.caption;
  caption.placeholder = "캡션";
  caption.addEventListener("input", (event) => {
    updateCanvasItem(item.id, { caption: event.target.value }, false);
  });

  const wrap = document.createElement("div");
  wrap.className = "canvas-image-stack";
  wrap.append(body, caption);
  return wrap;
}

function startCanvasDrag(event, item, element) {
  if (element.classList.contains("is-canvas-maximized")) {
    return;
  }

  if (item.locked) {
    showCanvasToast("위치가 고정된 박스입니다");
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  activateCanvasItem(item.id);

  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = item.x;
  const startTop = item.y;
  let nextX = startLeft;
  let nextY = startTop;

  element.setPointerCapture?.(event.pointerId);

  function handleMove(moveEvent) {
    nextX = clamp(startLeft + moveEvent.clientX - startX, 0, CANVAS_DEFAULTS.maxX);
    nextY = clamp(startTop + moveEvent.clientY - startY, 0, CANVAS_DEFAULTS.maxY);
    element.style.left = nextX + "px";
    element.style.top = nextY + "px";
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    updateCanvasItem(item.id, { x: Math.round(nextX), y: Math.round(nextY), z: getNextZ() }, false);
    element.style.zIndex = String(zCounter);
    resizeCanvasToContent(getActiveCanvasItems());
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function startCanvasResize(event, item, element) {
  if (element.classList.contains("is-canvas-maximized") || element.classList.contains("is-canvas-minimized")) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  activateCanvasItem(item.id);

  const startX = event.clientX;
  const startY = event.clientY;
  const startWidth = item.width;
  const startHeight = item.height;
  const minWidth = item.type === "image" ? CANVAS_DEFAULTS.minImageWidth : CANVAS_DEFAULTS.minTextWidth;
  const minHeight = item.type === "image" ? CANVAS_DEFAULTS.minImageHeight : CANVAS_DEFAULTS.minTextHeight;
  const aspectRatio = item.type === "image" ? getImageAspectRatio(item) : undefined;
  let nextWidth = startWidth;
  let nextHeight = startHeight;

  function handleMove(moveEvent) {
    if (item.type === "image") {
      const widthByX = clamp(startWidth + moveEvent.clientX - startX, minWidth, 900);
      const heightByY = clamp(startHeight + moveEvent.clientY - startY, minHeight, 700);

      if (Math.abs(moveEvent.clientY - startY) > Math.abs(moveEvent.clientX - startX)) {
        nextHeight = heightByY;
        nextWidth = clamp(Math.round(nextHeight * aspectRatio), minWidth, 900);
        nextHeight = Math.round(nextWidth / aspectRatio);
      } else {
        nextWidth = widthByX;
        nextHeight = clamp(Math.round(nextWidth / aspectRatio), minHeight, 700);
        nextWidth = Math.round(nextHeight * aspectRatio);
      }

      element.style.width = nextWidth + "px";
      element.style.height = nextHeight + "px";
      return;
    }

    nextWidth = clamp(startWidth + moveEvent.clientX - startX, minWidth, 1200);
    nextHeight = clamp(startHeight + moveEvent.clientY - startY, minHeight, 900);
    element.style.width = nextWidth + "px";
    element.style.height = nextHeight + "px";
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    updateCanvasItem(item.id, { width: Math.round(nextWidth), height: Math.round(nextHeight), aspectRatio }, false);
    resizeCanvasToContent(getActiveCanvasItems());
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}


function getCanvasPoint(event) {
  const rect = elements.memoCanvas.getBoundingClientRect();
  const wrap = elements.memoCanvas.parentElement;

  return {
    x: clamp(Math.round(event.clientX - rect.left + (wrap?.scrollLeft || 0)), 16, CANVAS_DEFAULTS.maxX),
    y: clamp(Math.round(event.clientY - rect.top + (wrap?.scrollTop || 0)), 16, CANVAS_DEFAULTS.maxY)
  };
}

function createContextButton(label, action, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.contextAction = action;

  if (options.value !== undefined) {
    button.dataset.contextValue = String(options.value);
  }

  if (options.danger) {
    button.classList.add("is-danger");
  }

  if (options.disabled) {
    button.disabled = true;
  }

  button.textContent = label;
  return button;
}

function createContextSeparator() {
  const separator = document.createElement("div");
  separator.className = "context-menu-separator";
  return separator;
}

function createContextMenuGroup(label, buttons) {
  const group = document.createElement("section");
  group.className = "context-menu-group";

  const title = document.createElement("span");
  title.textContent = label;

  const actions = document.createElement("div");
  actions.className = "context-menu-actions";
  buttons.forEach((button) => actions.append(button));
  group.append(title, actions);
  return group;
}

function createContextSubmenu(label, buttons) {
  const submenu = document.createElement("section");
  submenu.className = "context-submenu";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "context-submenu-trigger";
  trigger.innerHTML = "<span>" + label + "</span><span aria-hidden=\"true\">›</span>";

  const panel = document.createElement("div");
  panel.className = "context-submenu-panel";
  buttons.forEach((button) => panel.append(button));

  submenu.append(trigger, panel);
  return submenu;
}

function renderCanvasContextMenu(item) {
  const menu = elements.canvasContextMenu;
  menu.innerHTML = "";
  menu.append(
    createContextMenuGroup("편집", [
      createContextButton("이름 변경", "edit-title"),
      createContextButton("복제", "duplicate"),
      createContextButton("복사", "copy"),
      createContextButton("잘라내기", "cut"),
      createContextButton("붙여넣기", "paste", { disabled: !canvasClipboard })
    ]),
    createContextSeparator(),
    createContextSubmenu("배치", [
      createContextButton("앞으로", "raise"),
      createContextButton("뒤로", "back"),
      createContextButton("맨 앞으로", "front"),
      createContextButton("맨 뒤로", "send-back"),
      createContextButton("왼쪽 정렬", "align-left"),
      createContextButton("위쪽 정렬", "align-top"),
      createContextButton("가운데 정렬", "align-center"),
      createContextButton("격자 정렬", "arrange-all")
    ]),
    createContextSubmenu("크기", [
      createContextButton(item.windowState === "maximized" ? "복원" : "최대화", "maximize"),
      createContextButton("기본 크기", "reset-size"),
      createContextButton("작게", "scale", { value: "0.9" }),
      createContextButton("크게", "scale", { value: "1.1" }),
      createContextButton("내용에 맞추기", "fit-content")
    ]),
    createContextSubmenu("스타일", [
      createContextButton("기본", "theme", { value: "plain" }),
      createContextButton("종이", "theme", { value: "paper" }),
      createContextButton("마커", "theme", { value: "marker" }),
      createContextButton("다크", "theme", { value: "dark" }),
      createContextButton("원본 이미지", "crop", { value: "original", disabled: item.type !== "image" }),
      createContextButton("정사각", "crop", { value: "square", disabled: item.type !== "image" }),
      createContextButton("와이드", "crop", { value: "wide", disabled: item.type !== "image" }),
      createContextButton("원형", "crop", { value: "circle", disabled: item.type !== "image" })
    ]),
    createContextSeparator(),
    createContextMenuGroup("관리", [
      createContextButton(item.locked ? "위치 고정 해제" : "위치 고정", "toggle-lock"),
      createContextButton(item.windowState === "minimized" ? "보이기" : "숨기기", "hide"),
      createContextButton("상세 정보", "details")
    ]),
    createContextSeparator(),
    createContextMenuGroup("삭제", [
      createContextButton("삭제", "delete", { danger: true })
    ])
  );
}

function positionCanvasContextMenu(event, menu) {
  const gap = 10;
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.hidden = false;
  menu.style.visibility = "hidden";

  const rect = menu.getBoundingClientRect();
  let left = event.clientX + gap;
  let top = event.clientY + gap;

  if (left + rect.width + 8 > window.innerWidth) {
    left = event.clientX - rect.width - gap;
  }

  if (top + rect.height + 8 > window.innerHeight) {
    top = event.clientY - rect.height - gap;
  }

  menu.style.left = clamp(left, 8, Math.max(8, window.innerWidth - rect.width - 8)) + "px";
  menu.style.top = clamp(top, 8, Math.max(8, window.innerHeight - rect.height - 8)) + "px";
  menu.classList.toggle("opens-left", left + rect.width + 240 > window.innerWidth);
  menu.style.visibility = "visible";
}

function showCanvasContextMenu(event, itemId) {
  event.preventDefault();
  event.stopPropagation();
  hideCanvasCloseMenu();
  contextMenuItemId = itemId;
  contextMenuPoint = getCanvasPoint(event);
  activateCanvasItem(itemId);

  const item = getActiveCanvasItems().find((canvasItem) => canvasItem.id === itemId);

  if (!item) {
    hideCanvasContextMenu();
    return;
  }

  renderCanvasContextMenu(item);
  positionCanvasContextMenu(event, elements.canvasContextMenu);
}

function hideCanvasContextMenu() {
  elements.canvasContextMenu.hidden = true;
  elements.canvasContextMenu.innerHTML = "";
  elements.canvasContextMenu.classList.remove("opens-left");
  contextMenuItemId = undefined;
  contextMenuPoint = undefined;
}

function getCanvasItemDefaultSize(item) {
  if (item.type === "image") {
    const aspectRatio = getImageAspectRatio(item);
    const width = CANVAS_DEFAULTS.imageWidth;
    return {
      width,
      height: Math.round(width / aspectRatio),
      aspectRatio
    };
  }

  return {
    width: CANVAS_DEFAULTS.textWidth,
    height: CANVAS_DEFAULTS.textHeight
  };
}

function getScaledCanvasItemSize(item, scale) {
  const minWidth = item.type === "image" ? CANVAS_DEFAULTS.minImageWidth : CANVAS_DEFAULTS.minTextWidth;
  const minHeight = item.type === "image" ? CANVAS_DEFAULTS.minImageHeight : CANVAS_DEFAULTS.minTextHeight;
  let width = clamp(Math.round(item.width * scale), minWidth, item.type === "image" ? 900 : 1200);
  let height = clamp(Math.round(item.height * scale), minHeight, item.type === "image" ? 700 : 900);

  if (item.type === "image") {
    const aspectRatio = getImageAspectRatio(item);
    height = Math.round(width / aspectRatio);

    if (height < minHeight) {
      height = minHeight;
      width = Math.round(height * aspectRatio);
    }
  }

  return { width, height };
}

function getCanvasItemFitSize(item) {
  if (item.type === "image") {
    return getCanvasItemDefaultSize(item);
  }

  const element = elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(item.id) + '"]');
  const body = element?.querySelector(".canvas-text-content");
  const width = clamp(item.width, CANVAS_DEFAULTS.minTextWidth, 900);
  const height = clamp((body?.scrollHeight || item.height - 30) + 42, CANVAS_DEFAULTS.minTextHeight, 720);
  return { width, height };
}

function focusCanvasItemTitle(itemId) {
  requestAnimationFrame(() => {
    const input = elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(itemId) + '"] .canvas-title-input');
    input?.focus();
    input?.select();
  });
}

function focusCanvasItemBody(item) {
  requestAnimationFrame(() => {
    const selector = item.type === "image" ? ".canvas-image-caption" : ".canvas-text-content";
    const target = elements.memoCanvas.querySelector('[data-item-id="' + CSS.escape(item.id) + '"] ' + selector);
    target?.focus();
  });
}

function copyCanvasItem(item, shouldCut = false) {
  canvasClipboard = normalizeCanvasItem({
    ...item,
    windowState: "normal",
    restoreGeometry: undefined,
    z: getNextZ()
  });

  const clipboardText = item.type === "text" ? item.text : item.caption || item.title;
  if (clipboardText && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(clipboardText).catch(() => {});
  }

  if (shouldCut) {
    removeCanvasItem(item.id);
    showCanvasToast("박스를 잘라냈습니다", [
      { label: "붙여넣기", action: () => pasteCanvasClipboard() }
    ]);
  } else {
    showCanvasToast("박스를 복사했습니다");
  }
}

function pasteCanvasClipboard() {
  if (!canvasClipboard) {
    return;
  }

  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);
  const item = normalizeCanvasItem({
    ...canvasClipboard,
    id: createId(),
    x: clamp(contextMenuPoint?.x ?? canvasClipboard.x + 28, 0, CANVAS_DEFAULTS.maxX),
    y: clamp(contextMenuPoint?.y ?? canvasClipboard.y + 28, 0, CANVAS_DEFAULTS.maxY),
    windowState: "normal",
    z: getNextZ()
  });

  activeCanvasItemId = item.id;
  syncCanvasItems([...items, item], true);
}

function showCanvasItemDetails(item) {
  const typeLabel = item.type === "image" ? "이미지" : "텍스트";
  const stateLabel = item.windowState === "minimized" ? "숨김" : item.windowState === "maximized" ? "최대화" : "표시";
  const lockLabel = item.locked ? "고정" : "이동 가능";
  showCanvasToast(typeLabel + " · " + Math.round(item.width) + "×" + Math.round(item.height) + " · x " + Math.round(item.x) + ", y " + Math.round(item.y) + " · " + stateLabel + " · " + lockLabel);
}

function getCanvasCloseMenu() {
  let menu = document.querySelector("[data-canvas-close-menu]");

  if (!menu) {
    menu = document.createElement("div");
    menu.className = "canvas-close-menu";
    menu.dataset.canvasCloseMenu = "true";
    document.body.append(menu);
  }

  return menu;
}

function hideCanvasCloseMenu() {
  const menu = document.querySelector("[data-canvas-close-menu]");

  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
  }
}

function showCanvasCloseMenu(event, itemId) {
  hideCanvasContextMenu();
  const item = getActiveCanvasItems().find((canvasItem) => canvasItem.id === itemId);

  if (!item) {
    return;
  }

  const menu = getCanvasCloseMenu();
  menu.innerHTML = "";

  const title = document.createElement("span");
  title.textContent = "박스 닫기";

  const hideButton = createContextButton(item.windowState === "minimized" ? "보이기" : "숨기기", "close-hide");
  const deleteButton = createContextButton("삭제", "close-delete", { danger: true });
  const cancelButton = createContextButton("취소", "close-cancel");

  menu.append(title, hideButton, deleteButton, cancelButton);
  menu.hidden = false;
  menu.dataset.itemId = itemId;

  const rect = menu.getBoundingClientRect();
  const left = clamp(event.clientX - rect.width + 12, 8, Math.max(8, window.innerWidth - rect.width - 8));
  const top = clamp(event.clientY + 8, 8, Math.max(8, window.innerHeight - rect.height - 8));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function handleCanvasCloseMenuAction(event) {
  const menu = event.target.closest("[data-canvas-close-menu]");
  const button = event.target.closest("[data-context-action]");

  if (!menu || !button) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const itemId = menu.dataset.itemId;
  const item = getActiveCanvasItems().find((canvasItem) => canvasItem.id === itemId);

  if (!item) {
    hideCanvasCloseMenu();
    return;
  }

  if (button.dataset.contextAction === "close-hide") {
    updateCanvasItem(item.id, { windowState: item.windowState === "minimized" ? "normal" : "minimized" }, true);
  } else if (button.dataset.contextAction === "close-delete") {
    removeCanvasItem(item.id, { undo: true });
  }

  hideCanvasCloseMenu();
}

function showCanvasToast(message, actions = []) {
  let toast = document.querySelector("[data-canvas-toast]");

  if (!toast) {
    toast = document.createElement("div");
    toast.className = "canvas-undo-toast";
    toast.dataset.canvasToast = "true";
    document.body.append(toast);
  }

  toast.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = message;
  toast.append(text);

  actions.forEach(({ label, action }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      action();
      toast.hidden = true;
    });
    toast.append(button);
  });

  toast.hidden = false;
  clearTimeout(canvasToastTimer);
  canvasToastTimer = setTimeout(() => {
    toast.hidden = true;
  }, actions.length ? 7000 : 3600);
}

function handleCanvasContextAction(event) {
  const button = event.target.closest("[data-context-action]");

  if (!button || !contextMenuItemId || button.disabled) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const action = button.dataset.contextAction;
  const value = button.dataset.contextValue;
  const items = getActiveCanvasItems();
  const item = items.find((canvasItem) => canvasItem.id === contextMenuItemId);

  if (!item) {
    hideCanvasContextMenu();
    return;
  }

  if (action === "delete") {
    removeCanvasItem(item.id, { undo: true });
    return;
  }

  if (action === "edit-title") {
    hideCanvasContextMenu();
    focusCanvasItemTitle(item.id);
    return;
  }

  if (action === "edit-body") {
    hideCanvasContextMenu();
    focusCanvasItemBody(item);
    return;
  }

  if (action === "copy") {
    copyCanvasItem(item);
  } else if (action === "cut") {
    copyCanvasItem(item, true);
  } else if (action === "paste") {
    pasteCanvasClipboard();
  } else if (action === "duplicate") {
    duplicateCanvasItem(item.id);
  } else if (action === "hide") {
    updateCanvasItem(item.id, { windowState: item.windowState === "minimized" ? "normal" : "minimized" }, true);
  } else if (action === "toggle-lock") {
    updateCanvasItem(item.id, { locked: !item.locked }, true);
  } else if (action === "details") {
    showCanvasItemDetails(item);
  } else if (action === "maximize") {
    toggleCanvasMaximize(item);
  } else if (action === "reset-size") {
    updateCanvasItem(item.id, { ...getCanvasItemDefaultSize(item), windowState: "normal", restoreGeometry: undefined }, true);
  } else if (action === "fit-content") {
    updateCanvasItem(item.id, { ...getCanvasItemFitSize(item), windowState: "normal" }, true);
  } else if (action === "scale") {
    updateCanvasItem(item.id, { ...getScaledCanvasItemSize(item, Number(value) || 1), windowState: "normal" }, true);
  } else if (action === "align-left") {
    updateCanvasItem(item.id, { x: 32, windowState: "normal", z: getNextZ() }, true);
  } else if (action === "align-top") {
    updateCanvasItem(item.id, { y: 32, windowState: "normal", z: getNextZ() }, true);
  } else if (action === "align-center") {
    const viewport = getCanvasViewportSize();
    updateCanvasItem(item.id, { x: Math.max(0, Math.round((viewport.width - item.width) / 2)), windowState: "normal", z: getNextZ() }, true);
  } else if (action === "arrange-all") {
    arrangeCanvasItems();
  } else if (action === "theme") {
    updateCanvasItem(item.id, { theme: value }, true);
  } else if (action === "crop") {
    updateCanvasItem(item.id, { crop: value }, true);
  } else if (action === "front") {
    updateCanvasItem(item.id, { z: getNextZ() }, true);
  } else if (action === "raise") {
    const maxZ = Math.max(...items.map((canvasItem) => canvasItem.z || 1), 1);
    updateCanvasItem(item.id, { z: Math.min(maxZ + 1, item.z + 1) }, true);
  } else if (action === "back") {
    updateCanvasItem(item.id, { z: Math.max(1, item.z - 1) }, true);
  } else if (action === "send-back") {
    updateCanvasItem(item.id, { z: 1 }, true);
  }

  hideCanvasContextMenu();
}

function selectionIsInside(element) {
  const selection = window.getSelection();
  return selection.rangeCount > 0 && element.contains(selection.anchorNode);
}

function insertIntoActiveText(before, after = "") {
  let editable = getActiveTextElement();

  if (!editable) {
    addCanvasText(before + after);
    return;
  }

  editable.focus();
  const selection = window.getSelection();

  if (!selectionIsInside(editable)) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const selectedText = selection.toString();
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(before + selectedText + after);
  range.insertNode(node);

  const cursor = before.length + selectedText.length;
  range.setStart(node, cursor);
  range.setEnd(node, cursor);
  selection.removeAllRanges();
  selection.addRange(range);
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

function handleCanvasTextKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    insertIntoActiveText("**", "**");
  }
}

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
  notes = notes.map(normalizeNote);
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
  renderCanvasForActiveNote();
}

function renderEditor() {
  const activeNote = getActiveNote();

  if (!activeNote) {
    createNote();
    return;
  }

  activeId = activeNote.id;
  const normalizedNote = normalizeNote(activeNote);
  if (normalizedNote !== activeNote) {
    notes = notes.map((note) => note.id === normalizedNote.id ? normalizedNote : note);
  }

  elements.titleInput.value = normalizedNote.title;
  elements.tagInput.value = normalizedNote.tags.join(", ");
  elements.contentInput.value = normalizedNote.content;
  updateEditorMeta(normalizedNote);
  renderImageBlocksForActiveNote();
  elements.pinButton.classList.toggle("is-active", normalizedNote.pinned);
  elements.pinButton.textContent = normalizedNote.pinned ? "고정됨" : "고정";
}

function render() {
  renderList();
  renderEditor();
}

function isEditingNote() {
  const activeElement = document.activeElement;

  return activeElement === elements.titleInput
    || activeElement === elements.tagInput
    || elements.memoCanvas.contains(activeElement);
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
    canvasItems: [createTextCanvasItem(initialContent)],
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

    const nextNote = normalizeNote({
      ...note,
      ...patch,
      updatedAt: now
    });

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
      canvasItems: [createTextCanvasItem("")],
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadActiveNote() {
  const note = getActiveNote();
  const basename = getExportBasename(note);
  const imageEntries = getNoteImages(note);
  const textBody = buildTextExport(note, imageEntries);
  const textFilename = basename + ".txt";

  if (imageEntries.length === 0) {
    downloadBlob(new Blob([textBody], { type: "text/plain;charset=utf-8" }), textFilename);
    return;
  }

  const zipBlob = buildZipBlob([
    { name: textFilename, data: textBody },
    ...buildImageFiles(imageEntries)
  ], note.updatedAt || Date.now());

  downloadBlob(zipBlob, basename + ".zip");
}

function getLineStart(value, position) {
  return value.lastIndexOf("\n", position - 1) + 1;
}

function insertAtCursor(text, wrapSelection = false) {
  insertIntoActiveText(text, wrapSelection ? text : "");
}

function prefixCurrentLine(prefix) {
  insertIntoActiveText(prefix);
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

  addCanvasText(template, {
    x: 72,
    y: 72 + getActiveCanvasItems().length * 24,
    width: CANVAS_DEFAULTS.textWidth,
    height: 300
  });
  elements.templateSelect.value = "";
}

function requestTextFile() {
  elements.textInput.click();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(file, "utf-8");
  });
}

function getTitleFromFilename(filename) {
  return filename.replace(/\.(txt|md|markdown)$/i, "").trim();
}

async function importSelectedText(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  elements.saveStatus.textContent = "텍스트 불러오는 중";

  try {
    const activeNote = getActiveNote();
    const text = await readFileAsText(file);
    const importedTitle = getTitleFromFilename(file.name);

    if (!activeNote.title.trim() && importedTitle) {
      elements.titleInput.value = importedTitle.slice(0, 80);
      updateActiveNote({ title: elements.titleInput.value }, false);
    }

    addCanvasText(text, {
      x: 76,
      y: 84 + getActiveCanvasItems().length * 28,
      width: CANVAS_DEFAULTS.textWidth,
      height: 320
    });
    elements.saveStatus.textContent = "텍스트 불러옴";
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "텍스트 불러오기 실패";
  } finally {
    event.target.value = "";
  }
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

async function addDroppedImages(files, point) {
  elements.saveStatus.textContent = "이미지 처리 중";

  try {
    const blocks = await createImageBlocksFromFiles(
      files,
      elements.imageLayoutSelect.value,
      elements.imageStyleSelect.value
    );

    if (blocks.length === 0) {
      elements.saveStatus.textContent = "이미지 파일 없음";
      return;
    }

    addCanvasImages(blocks, point);
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "이미지 추가 실패";
  }
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

    addCanvasImages(blocks);
  } catch (error) {
    console.error(error);
    elements.saveStatus.textContent = "이미지 추가 실패";
  } finally {
    event.target.value = "";
  }
}

function handleAppError(error, fallbackStatus = "오류가 발생했습니다") {
  console.error(error);

  if (elements.saveStatus) {
    elements.saveStatus.textContent = fallbackStatus;
  }
}

function bind(element, eventName, handler, fallbackStatus) {
  if (!element) {
    return;
  }

  element.addEventListener(eventName, (event) => {
    try {
      handler(event);
    } catch (error) {
      handleAppError(error, fallbackStatus);
    }
  });
}

function bindAll(selector, eventName, handler, fallbackStatus) {
  document.querySelectorAll(selector).forEach((element) => {
    bind(element, eventName, handler, fallbackStatus);
  });
}

function initializeApp() {
  initializeNotes();

  bind(elements.newNoteButton, "click", () => createNote(), "새 메모 생성 실패");
  bind(elements.searchInput, "input", renderList, "검색 실패");
  bind(elements.titleInput, "input", (event) => {
    updateActiveNote({ title: event.target.value }, false);
  }, "제목 저장 실패");
  bind(elements.tagInput, "input", (event) => {
    updateActiveNote({ tags: parseTags(event.target.value) }, false);
  }, "태그 저장 실패");
  bind(elements.contentInput, "input", (event) => {
    updateActiveNote({ content: event.target.value }, false);
  }, "본문 저장 실패");
  bindAll("[data-action]", "click", (event) => applyFormat(event.currentTarget.dataset.action), "서식 적용 실패");
  bind(elements.templateSelect, "change", (event) => insertTemplate(event.target.value), "템플릿 삽입 실패");
  bind(elements.addTextButton, "click", () => addCanvasText(""), "텍스트 추가 실패");
  bind(elements.importTextButton, "click", requestTextFile, "텍스트 파일 선택 실패");
  bind(elements.textInput, "change", importSelectedText, "텍스트 불러오기 실패");
  bind(elements.addImageButton, "click", requestImageFiles, "이미지 선택 실패");
  bind(elements.imageInput, "change", addSelectedImages, "이미지 추가 실패");
  bind(elements.pinButton, "click", () => {
    const note = getActiveNote();
    updateActiveNote({ pinned: !note.pinned });
  }, "고정 상태 변경 실패");
  bind(elements.downloadButton, "click", downloadActiveNote, "다운로드 실패");
  bind(elements.deleteButton, "click", deleteActiveNote, "메모 삭제 실패");
  bind(elements.memoCanvas, "dblclick", (event) => {
    if (event.target === elements.memoCanvas) {
      addCanvasText("", getCanvasPoint(event));
    }
  }, "텍스트 추가 실패");
  bind(elements.memoCanvas, "dragover", (event) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
    }
  }, "드래그 처리 실패");
  bind(elements.memoCanvas, "drop", (event) => {
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));

    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    addDroppedImages(files, getCanvasPoint(event));
  }, "이미지 추가 실패");
  bind(elements.canvasContextMenu, "click", handleCanvasContextAction, "메뉴 실행 실패");
  bind(document, "click", (event) => {
    const closeMenu = document.querySelector("[data-canvas-close-menu]");

    if (!elements.canvasContextMenu.contains(event.target)) {
      hideCanvasContextMenu();
    }

    if (closeMenu && !closeMenu.contains(event.target)) {
      hideCanvasCloseMenu();
    }
  });
  bind(document, "click", handleCanvasCloseMenuAction, "닫기 메뉴 실행 실패");
  bind(window, "resize", () => resizeCanvasToContent());
  bind(window, "beforeunload", () => unsubscribeNotes?.());

  setupToolPanel();
  setupMiniApps();
  render();
  connectFirestore();
}

try {
  initializeApp();
} catch (error) {
  handleAppError(error, "앱 초기화 실패");
}
