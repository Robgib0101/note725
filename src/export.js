import { getTitle } from "./text.js";

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampWidth(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 100;
  }

  return Math.min(100, Math.max(35, Math.round(number)));
}

function getCropStyle(crop) {
  const crops = {
    square: "aspect-ratio:1/1;object-fit:cover;",
    wide: "aspect-ratio:16/9;object-fit:cover;",
    portrait: "aspect-ratio:4/5;object-fit:cover;",
    circle: "aspect-ratio:1/1;object-fit:cover;border-radius:999px;"
  };

  return crops[crop] ?? "height:auto;object-fit:contain;";
}

function getNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildCanvasExport(note) {
  const items = Array.isArray(note.canvasItems) ? note.canvasItems : [];

  if (items.length === 0) {
    return "";
  }

  const width = Math.max(760, ...items.map((item) => getNumber(item.x, 0) + getNumber(item.width, 260) + 80));
  const height = Math.max(520, ...items.map((item) => getNumber(item.y, 0) + getNumber(item.height, 160) + 80));
  const blocks = items.map((item) => {
    const x = Math.round(getNumber(item.x, 40));
    const y = Math.round(getNumber(item.y, 40));
    const itemWidth = Math.round(getNumber(item.width, item.type === "image" ? 320 : 460));
    const itemHeight = Math.round(getNumber(item.height, item.type === "image" ? 220 : 180));
    const baseStyle = 'left:' + x + 'px;top:' + y + 'px;width:' + itemWidth + 'px;min-height:' + itemHeight + 'px;';

    if (item.type === "image") {
      const cropStyle = getCropStyle(item.crop || "original");
      const images = (item.images ?? []).map((image) => (
        '<img src="' + image.src + '" alt="' + escapeHtml(image.name || "첨부 이미지") + '" style="' + cropStyle + '">'
      )).join("");

      return '<figure class="canvas-item canvas-image" style="' + baseStyle + '">' + images
        + '<figcaption>' + escapeHtml(item.caption ?? "") + '</figcaption></figure>';
    }

    return '<section class="canvas-item canvas-text" style="' + baseStyle + '"><pre>'
      + escapeHtml(item.text ?? "")
      + '</pre></section>';
  }).join("");

  return '<section class="canvas-export" style="width:' + Math.round(width) + 'px;min-height:' + Math.round(height) + 'px">' + blocks + '</section>';
}

export function buildTextExport(note) {
  const tags = note.tags?.length ? "\n\nTags: " + note.tags.map((tag) => "#" + tag).join(" ") : "";

  return getTitle(note) + "\n\n" + note.content + tags;
}

export function buildHtmlExport(note) {
  const canvasExport = buildCanvasExport(note);
  const imageBlocks = canvasExport ? "" : (note.images ?? []).map((block) => {
    const crop = block.crop || "original";
    const width = clampWidth(block.width ?? 100);
    const imageStyle = getCropStyle(crop);
    const images = block.images.map((image) => (
      '<img src="' + image.src + '" alt="' + escapeHtml(image.name || "첨부 이미지") + '" style="' + imageStyle + '">'
    )).join("");

    return '<section class="image-block" style="max-width:' + width + '%">' + images
      + '<p>' + escapeHtml(block.caption ?? "") + '</p>'
      + '<pre>' + escapeHtml(block.note ?? "") + '</pre>'
      + '</section>';
  }).join("");

  return '<!doctype html><html lang="ko"><meta charset="utf-8"><title>'
    + escapeHtml(getTitle(note))
    + '</title><style>body{font-family:system-ui,sans-serif;margin:40px;line-height:1.6;color:#1f2523}body>pre,body>h1{max-width:760px}.canvas-export{position:relative;overflow:auto;background:#fbfcfa;border:1px solid #d5ded9;border-radius:8px}.canvas-item{position:absolute;box-sizing:border-box;padding:12px;background:#fff;border:1px solid #d5ded9;border-radius:8px;box-shadow:0 8px 24px rgba(23,42,38,.12)}.canvas-text pre{margin:0;white-space:pre-wrap;font:inherit}.canvas-image{padding:0;overflow:hidden}.canvas-image img{display:block;width:100%;max-width:100%;border-radius:8px}.canvas-image figcaption{padding:8px 10px;color:#65736f}.image-block{margin:24px 0;max-width:760px}pre{white-space:pre-wrap}</style><h1>'
    + escapeHtml(getTitle(note))
    + '</h1><pre>'
    + escapeHtml(note.content)
    + '</pre>'
    + (canvasExport || imageBlocks)
    + '</html>';
}
