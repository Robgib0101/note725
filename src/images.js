import { createId } from "./storage.js";

const layoutOptions = [
  ["inline", "본문형"],
  ["caption", "캡션형"],
  ["side", "좌우"],
  ["cover", "커버"],
  ["gallery", "갤러리"]
];

const styleOptions = [
  ["clean", "깔끔"],
  ["paper", "종이"],
  ["marker", "마커"],
  ["shadow", "그림자"]
];

const cropOptions = [
  ["original", "원본"],
  ["square", "정사각"],
  ["wide", "와이드"],
  ["portrait", "세로"],
  ["circle", "원형"]
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function clampWidth(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 100;
  }

  return Math.min(100, Math.max(35, Math.round(number)));
}

function normalizeBlock(block) {
  return {
    ...block,
    layout: block.layout || "inline",
    style: block.style || "clean",
    crop: block.crop || "original",
    width: clampWidth(block.width ?? 100),
    caption: block.caption ?? "",
    note: block.note ?? "",
    images: Array.isArray(block.images) ? block.images : []
  };
}

export async function createImageBlocksFromFiles(files, layout, style) {
  const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
  const images = await Promise.all(
    imageFiles.map(async (file) => ({
      id: createId(),
      name: file.name,
      src: await readFileAsDataUrl(file)
    }))
  );

  if (images.length === 0) {
    return [];
  }

  if (layout === "gallery") {
    return [{
      id: createId(),
      layout,
      style,
      crop: "square",
      width: 100,
      caption: "",
      note: "",
      images
    }];
  }

  return images.map((image) => ({
    id: createId(),
    layout,
    style,
    crop: layout === "cover" ? "wide" : "original",
    width: 100,
    caption: "",
    note: "",
    images: [image]
  }));
}

function createImage(image) {
  const img = document.createElement("img");
  img.src = image.src;
  img.alt = image.name || "첨부 이미지";
  img.loading = "lazy";
  return img;
}

function createSelect(label, value, options, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "image-control-wrap";

  const text = document.createElement("span");
  text.textContent = label;

  const select = document.createElement("select");
  select.className = "image-control-select";
  options.forEach(([optionValue, optionLabel]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    select.append(option);
  });
  select.value = value;
  select.addEventListener("change", (event) => onChange(event.target.value));

  wrap.append(text, select);
  return wrap;
}

function createActionButton(label, title, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "image-action-button";
  button.textContent = label;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function getBlockTitle(block) {
  const firstImage = block.images[0];
  const suffix = block.images.length > 1 ? " 외 " + (block.images.length - 1) + "개" : "";

  return (firstImage?.name || "이미지") + suffix;
}

function createTextPanel(block, handlers) {
  const textPanel = document.createElement("div");
  textPanel.className = "image-text-panel";

  const caption = document.createElement("input");
  caption.className = "image-caption-input";
  caption.type = "text";
  caption.value = block.caption;
  caption.placeholder = "이미지 캡션";
  caption.addEventListener("input", (event) => {
    handlers.onTextInput(block.id, { caption: event.target.value });
  });

  const note = document.createElement("textarea");
  note.className = "image-note-input";
  note.value = block.note;
  note.placeholder = "이미지 메모";
  note.addEventListener("input", (event) => {
    handlers.onTextInput(block.id, { note: event.target.value });
  });

  textPanel.append(caption, note);
  return textPanel;
}

function createImageMedia(block) {
  const media = document.createElement("div");
  media.className = "image-media image-crop--" + block.crop;
  block.images.slice(0, 1).forEach((image) => media.append(createImage(image)));
  return media;
}

function createGallery(block) {
  const grid = document.createElement("div");
  grid.className = "image-grid";

  block.images.forEach((image) => {
    const item = document.createElement("figure");
    item.className = "image-grid-item image-crop--" + block.crop;
    item.append(createImage(image));
    grid.append(item);
  });

  return grid;
}

export function renderImageBlocks(container, blocks, handlers) {
  const normalizedBlocks = blocks.map(normalizeBlock);
  container.innerHTML = "";
  container.hidden = normalizedBlocks.length === 0;

  normalizedBlocks.forEach((block, index) => {
    const article = document.createElement("article");
    article.className = "image-block image-block--" + block.layout + " image-style--" + block.style;
    article.style.maxWidth = block.width + "%";

    const toolbar = document.createElement("div");
    toolbar.className = "image-block-toolbar";

    const title = document.createElement("span");
    title.className = "image-block-title";
    title.textContent = getBlockTitle(block);

    const controls = document.createElement("div");
    controls.className = "image-block-controls";
    controls.append(
      createSelect("배치", block.layout, layoutOptions, (value) => {
        handlers.onBlockChange(block.id, { layout: value }, true);
      }),
      createSelect("스타일", block.style, styleOptions, (value) => {
        handlers.onBlockChange(block.id, { style: value }, true);
      }),
      createSelect("자르기", block.crop, cropOptions, (value) => {
        handlers.onBlockChange(block.id, { crop: value }, true);
      })
    );

    const sizeControl = document.createElement("label");
    sizeControl.className = "image-range-control";

    const sizeText = document.createElement("span");
    sizeText.textContent = "크기";

    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "35";
    sizeInput.max = "100";
    sizeInput.step = "5";
    sizeInput.value = String(block.width);

    const sizeOutput = document.createElement("output");
    sizeOutput.textContent = block.width + "%";

    sizeInput.addEventListener("input", (event) => {
      const width = clampWidth(event.target.value);
      article.style.maxWidth = width + "%";
      sizeOutput.textContent = width + "%";
      handlers.onTextInput(block.id, { width });
    });

    sizeControl.append(sizeText, sizeInput, sizeOutput);
    controls.append(
      sizeControl,
      createActionButton("↑", "위로 이동", () => handlers.onMove(block.id, -1), index === 0),
      createActionButton("↓", "아래로 이동", () => handlers.onMove(block.id, 1), index === normalizedBlocks.length - 1),
      createActionButton("×", "이미지 삭제", () => handlers.onRemove(block.id))
    );

    toolbar.append(title, controls);

    const body = document.createElement("div");
    body.className = "image-block-body";

    if (block.layout === "gallery") {
      body.append(createGallery(block), createTextPanel(block, handlers));
    } else {
      body.append(createImageMedia(block), createTextPanel(block, handlers));
    }

    article.append(toolbar, body);
    container.append(article);
  });
}
