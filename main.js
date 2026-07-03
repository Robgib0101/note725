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
import { createImageBlocksFromFiles } from "./src/images.js";
import { buildHtmlExport, buildTextExport } from "./src/export.js";

let notes = loadNotes();
let activeId = notes[0]?.id;
let saveTimer;
let saveRevision = 0;
let notesStore;
let unsubscribeNotes;
let activeCanvasItemId;
let contextMenuItemId;
let zCounter = 20;
let panelWindowZ = 70;

const CANVAS_DEFAULTS = {
  textWidth: 520,
  textHeight: 260,
  imageWidth: 320,
  imageHeight: 230,
  minTextWidth: 180,
  minTextHeight: 110,
  minImageWidth: 120,
  minImageHeight: 90,
  maxX: 2400,
  maxY: 1800
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCanvasItem(item, index = 0) {
  const type = item?.type === "image" ? "image" : "text";
  const minWidth = type === "image" ? CANVAS_DEFAULTS.minImageWidth : CANVAS_DEFAULTS.minTextWidth;
  const minHeight = type === "image" ? CANVAS_DEFAULTS.minImageHeight : CANVAS_DEFAULTS.minTextHeight;
  const fallbackWidth = type === "image" ? CANVAS_DEFAULTS.imageWidth : CANVAS_DEFAULTS.textWidth;
  const fallbackHeight = type === "image" ? CANVAS_DEFAULTS.imageHeight : CANVAS_DEFAULTS.textHeight;

  return {
    id: item?.id || createId(),
    type,
    text: item?.text ?? "",
    images: Array.isArray(item?.images) ? item.images : [],
    caption: item?.caption ?? "",
    note: item?.note ?? "",
    theme: item?.theme || item?.style || "plain",
    crop: item?.crop || "original",
    x: clamp(normalizeNumber(item?.x, 56 + index * 28), 0, CANVAS_DEFAULTS.maxX),
    y: clamp(normalizeNumber(item?.y, 56 + index * 28), 0, CANVAS_DEFAULTS.maxY),
    width: clamp(normalizeNumber(item?.width, fallbackWidth), minWidth, 1200),
    height: clamp(normalizeNumber(item?.height, fallbackHeight), minHeight, 900),
    windowState: item?.windowState === "minimized" ? "minimized" : "normal",
    z: normalizeNumber(item?.z, index + 1)
  };
}

function createTextCanvasItem(text = "", position = {}) {
  return normalizeCanvasItem({
    id: createId(),
    type: "text",
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
  return normalizeCanvasItem({
    id: createId(),
    type: "image",
    images: [image],
    caption: source.caption ?? "",
    note: source.note ?? "",
    theme: source.theme || source.style || "plain",
    crop: source.crop || "original",
    x: position.x ?? 80,
    y: position.y ?? 90,
    width: position.width ?? CANVAS_DEFAULTS.imageWidth,
    height: position.height ?? CANVAS_DEFAULTS.imageHeight,
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

function getCanvasItems(note) {
  if (!note) {
    return [];
  }

  if (Array.isArray(note.canvasItems) && note.canvasItems.length > 0) {
    return note.canvasItems.map(normalizeCanvasItem);
  }

  const items = [];
  const content = note.content ?? "";

  items.push(createTextCanvasItem(content, {
    x: 56,
    y: 56,
    width: CANVAS_DEFAULTS.textWidth,
    height: content.trim() ? CANVAS_DEFAULTS.textHeight : 220
  }));

  items.push(...convertLegacyImagesToCanvasItems(note.images ?? []));
  return items;
}

function ensureCanvasItems(note) {
  const items = getCanvasItems(note);

  if (!Array.isArray(note.canvasItems) || note.canvasItems.length === 0) {
    note.canvasItems = items;
    note.content = deriveContentFromCanvasItems(items);
    note.images = deriveImagesFromCanvasItems(items);
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
      width: Math.round(item.width),
      height: Math.round(item.height),
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

function removeCanvasItem(itemId) {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote).filter((item) => item.id !== itemId);
  const nextItems = items.length ? items : [createTextCanvasItem("")];

  if (activeCanvasItemId === itemId) {
    activeCanvasItemId = nextItems[0]?.id;
  }

  hideCanvasContextMenu();
  syncCanvasItems(nextItems, true);
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

function renderCanvasForActiveNote() {
  const activeNote = getActiveNote();
  const items = ensureCanvasItems(activeNote);

  elements.memoCanvas.innerHTML = "";
  elements.contentInput.value = deriveContentFromCanvasItems(items);

  items.forEach((item) => {
    elements.memoCanvas.append(createCanvasElement(item));
  });

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
  button.textContent = minimized ? "▣" : "−";
  button.title = minimized ? "복원" : "최소화";
  button.setAttribute("aria-label", button.title);
  updateCanvasItem(item.id, { windowState: minimized ? "minimized" : "normal" }, false);
}

function restoreCanvasMaximize(element, button) {
  const restore = JSON.parse(element.dataset.restoreGeometry || "{}");
  element.classList.remove("is-canvas-maximized");

  if (restore.left) {
    element.style.left = restore.left;
    element.style.top = restore.top;
    element.style.width = restore.width;
    element.style.minHeight = restore.minHeight;
  }

  button.textContent = "□";
  button.title = "최대화";
  button.setAttribute("aria-label", "최대화");
  delete element.dataset.restoreGeometry;
}

function toggleCanvasMaximize(item, element, button) {
  if (element.classList.contains("is-canvas-maximized")) {
    restoreCanvasMaximize(element, button);
    return;
  }

  const wrap = elements.memoCanvas.parentElement;
  element.dataset.restoreGeometry = JSON.stringify({
    left: element.style.left,
    top: element.style.top,
    width: element.style.width,
    minHeight: element.style.minHeight
  });

  element.classList.remove("is-canvas-minimized");
  element.classList.add("is-canvas-maximized");
  element.style.left = wrap.scrollLeft + 18 + "px";
  element.style.top = wrap.scrollTop + 18 + "px";
  element.style.width = clamp(wrap.clientWidth - 36, item.type === "image" ? 320 : 440, 1120) + "px";
  element.style.minHeight = clamp(wrap.clientHeight - 36, item.type === "image" ? 260 : 300, 820) + "px";
  element.style.zIndex = String(getNextZ());
  button.textContent = "❐";
  button.title = "복원";
  button.setAttribute("aria-label", "복원");
}

function createCanvasItemTitlebar(item, element) {
  const grip = document.createElement("div");
  grip.className = "canvas-item-grip";
  grip.title = "드래그해서 이동";

  const title = document.createElement("span");
  title.className = "canvas-window-title";
  title.textContent = item.type === "image" ? "이미지 창" : "텍스트 창";

  const controls = document.createElement("span");
  controls.className = "canvas-window-controls";

  const minimizeButton = createCanvasWindowButton(
    "minimize",
    item.windowState === "minimized" ? "복원" : "최소화",
    item.windowState === "minimized" ? "▣" : "−"
  );
  minimizeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCanvasMinimize(item, element, minimizeButton);
  });

  const maximizeButton = createCanvasWindowButton("maximize", "최대화", "□");
  maximizeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCanvasMaximize(item, element, maximizeButton);
  });

  const closeButton = createCanvasWindowButton("close", "닫기", "×");
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeCanvasItem(item.id);
  });

  controls.append(minimizeButton, maximizeButton, closeButton);
  grip.append(title, controls);
  grip.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) {
      return;
    }

    startCanvasDrag(event, item, element);
  });

  return grip;
}

function createCanvasElement(item) {
  const element = document.createElement("article");
  element.className = "canvas-item canvas-item--" + item.type + " canvas-theme--" + item.theme + " canvas-crop--" + item.crop;
  element.classList.toggle("is-canvas-minimized", item.windowState === "minimized");
  element.dataset.itemId = item.id;
  element.dataset.itemType = item.type;
  element.style.left = item.x + "px";
  element.style.top = item.y + "px";
  element.style.width = item.width + "px";
  element.style.minHeight = item.height + "px";
  element.style.zIndex = String(item.z);
  element.tabIndex = 0;

  const grip = createCanvasItemTitlebar(item, element);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "canvas-resize-handle";
  resizeHandle.title = "드래그해서 크기 변경";
  resizeHandle.addEventListener("pointerdown", (event) => startCanvasResize(event, item, element));

  element.addEventListener("pointerdown", () => activateCanvasItem(item.id));
  element.addEventListener("contextmenu", (event) => showCanvasContextMenu(event, item.id));

  if (item.type === "image") {
    element.append(grip, createCanvasImageBody(item), resizeHandle);
  } else {
    element.append(grip, createCanvasTextBody(item), resizeHandle);
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
  let nextWidth = startWidth;
  let nextHeight = startHeight;

  function handleMove(moveEvent) {
    nextWidth = clamp(startWidth + moveEvent.clientX - startX, minWidth, 1200);
    nextHeight = clamp(startHeight + moveEvent.clientY - startY, minHeight, 900);
    element.style.width = nextWidth + "px";
    element.style.minHeight = nextHeight + "px";
  }

  function handleUp() {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    updateCanvasItem(item.id, { width: Math.round(nextWidth), height: Math.round(nextHeight) }, false);
  }

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function getCanvasPoint(event) {
  const rect = elements.memoCanvas.getBoundingClientRect();
  return {
    x: clamp(Math.round(event.clientX - rect.left + elements.memoCanvas.scrollLeft), 16, CANVAS_DEFAULTS.maxX),
    y: clamp(Math.round(event.clientY - rect.top + elements.memoCanvas.scrollTop), 16, CANVAS_DEFAULTS.maxY)
  };
}

function showCanvasContextMenu(event, itemId) {
  event.preventDefault();
  contextMenuItemId = itemId;
  activateCanvasItem(itemId);

  const item = getActiveCanvasItems().find((canvasItem) => canvasItem.id === itemId);
  const menu = elements.canvasContextMenu;
  const cropGroup = menu.querySelector('[data-context-group="crop"]');
  cropGroup.hidden = item?.type !== "image";

  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = clamp(event.clientX, 8, window.innerWidth - menuRect.width - 8) + "px";
  menu.style.top = clamp(event.clientY, 8, window.innerHeight - menuRect.height - 8) + "px";
}

function hideCanvasContextMenu() {
  elements.canvasContextMenu.hidden = true;
  contextMenuItemId = undefined;
}

function handleCanvasContextAction(event) {
  const button = event.target.closest("[data-context-action]");

  if (!button || !contextMenuItemId) {
    return;
  }

  const action = button.dataset.contextAction;
  const value = button.dataset.contextValue;
  const items = getActiveCanvasItems();
  const item = items.find((canvasItem) => canvasItem.id === contextMenuItemId);

  if (!item) {
    hideCanvasContextMenu();
    return;
  }

  if (action === "delete") {
    removeCanvasItem(item.id);
    return;
  }

  if (action === "theme") {
    updateCanvasItem(item.id, { theme: value }, true);
  } else if (action === "crop") {
    updateCanvasItem(item.id, { crop: value }, true);
  } else if (action === "front") {
    updateCanvasItem(item.id, { z: getNextZ() }, true);
  } else if (action === "back") {
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

function downloadActiveNote() {
  const note = getActiveNote();
  const hasImages = getImageCount(note) > 0;
  const hasCanvasLayout = (note.canvasItems?.length ?? 0) > 1 || note.canvasItems?.some((item) => item.type === "image");
  const shouldExportHtml = hasImages || hasCanvasLayout;
  const filename = getSafeFilename(getTitle(note), shouldExportHtml ? ".html" : ".txt");
  const body = shouldExportHtml ? buildHtmlExport(note) : buildTextExport(note);
  const type = shouldExportHtml ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
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
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => applyFormat(button.dataset.action));
});
elements.templateSelect.addEventListener("change", (event) => insertTemplate(event.target.value));
elements.addTextButton.addEventListener("click", () => addCanvasText(""));
elements.importTextButton.addEventListener("click", requestTextFile);
elements.textInput.addEventListener("change", importSelectedText);
elements.addImageButton.addEventListener("click", requestImageFiles);
elements.imageInput.addEventListener("change", addSelectedImages);
elements.focusButton.addEventListener("click", () => {
  isFocusMode = !isFocusMode;
  elements.appShell.classList.toggle("is-focus-mode", isFocusMode);
  renderEditor();
  focusCanvasTextItem(getActiveTextItem()?.id);
});
elements.pinButton.addEventListener("click", () => {
  const note = getActiveNote();
  updateActiveNote({ pinned: !note.pinned });
});
elements.downloadButton.addEventListener("click", downloadActiveNote);
elements.deleteButton.addEventListener("click", deleteActiveNote);
elements.memoCanvas.addEventListener("dblclick", (event) => {
  if (event.target === elements.memoCanvas) {
    addCanvasText("", getCanvasPoint(event));
  }
});
elements.memoCanvas.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
    event.preventDefault();
  }
});
elements.memoCanvas.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));

  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  addDroppedImages(files, getCanvasPoint(event));
});
elements.canvasContextMenu.addEventListener("click", handleCanvasContextAction);
document.addEventListener("click", (event) => {
  if (!elements.canvasContextMenu.contains(event.target)) {
    hideCanvasContextMenu();
  }
});
window.addEventListener("beforeunload", () => unsubscribeNotes?.());

setupPanelWindows();
render();
connectFirestore();
