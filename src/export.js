import { getTitle } from "./text.js";

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildTextExport(note) {
  const tags = note.tags?.length ? "\n\nTags: " + note.tags.map((tag) => "#" + tag).join(" ") : "";

  return getTitle(note) + "\n\n" + note.content + tags;
}

export function buildHtmlExport(note) {
  const imageBlocks = (note.images ?? []).map((block) => {
    const images = block.images.map((image) => (
      '<img src="' + image.src + '" alt="' + escapeHtml(image.name || "첨부 이미지") + '">'
    )).join("");

    return '<section class="image-block">' + images
      + '<p>' + escapeHtml(block.caption ?? "") + '</p>'
      + '<pre>' + escapeHtml(block.note ?? "") + '</pre>'
      + '</section>';
  }).join("");

  return '<!doctype html><html lang="ko"><meta charset="utf-8"><title>'
    + escapeHtml(getTitle(note))
    + '</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;line-height:1.6}img{max-width:100%;border-radius:8px}.image-block{margin:24px 0}pre{white-space:pre-wrap}</style><h1>'
    + escapeHtml(getTitle(note))
    + '</h1><pre>'
    + escapeHtml(note.content)
    + '</pre>'
    + imageBlocks
    + '</html>';
}
