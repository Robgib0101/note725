import { createId } from "./storage.js";

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
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
      caption: "",
      note: "",
      images
    }];
  }

  return images.map((image) => ({
    id: createId(),
    layout,
    style,
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

export function renderImageBlocks(container, blocks, handlers) {
  container.innerHTML = "";
  container.hidden = blocks.length === 0;

  blocks.forEach((block) => {
    const article = document.createElement("article");
    article.className = "image-block image-block-" + block.layout + " image-style-" + block.style;

    const imageWrap = document.createElement("div");
    imageWrap.className = "image-block-media";
    block.images.forEach((image) => imageWrap.append(createImage(image)));

    const controls = document.createElement("div");
    controls.className = "image-block-controls";

    [
      ["위", () => handlers.onMove(block.id, -1)],
      ["아래", () => handlers.onMove(block.id, 1)],
      ["삭제", () => handlers.onRemove(block.id)]
    ].forEach(([label, onClick]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", onClick);
      controls.append(button);
    });

    const caption = document.createElement("input");
    caption.type = "text";
    caption.value = block.caption ?? "";
    caption.placeholder = "이미지 캡션";
    caption.addEventListener("input", (event) => {
      handlers.onTextInput(block.id, { caption: event.target.value });
    });

    const note = document.createElement("textarea");
    note.value = block.note ?? "";
    note.placeholder = "이미지 메모";
    note.addEventListener("input", (event) => {
      handlers.onTextInput(block.id, { note: event.target.value });
    });

    article.append(imageWrap, caption, note, controls);
    container.append(article);
  });
}
