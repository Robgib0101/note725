function getCanvasText(note) {
  return (note.canvasItems ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n\n");
}

function getFirstContentLine(note) {
  const content = note.content || getCanvasText(note);
  return content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function formatTimestamp(value = Date.now()) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join("-");
}

function sanitizeFilename(value) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function getExportBasename(note) {
  const title = note.title?.trim() || "";
  const firstLine = getFirstContentLine(note);
  const fallback = "note-" + formatTimestamp(note.updatedAt || Date.now());

  return sanitizeFilename(title || firstLine || fallback) || fallback;
}

function getImageExtension(image) {
  const fromName = image.name?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  if (fromName) {
    return fromName.toLowerCase();
  }

  const fromDataUrl = image.src?.match(/^data:image\/([a-z0-9.+-]+);/i)?.[1];
  if (!fromDataUrl) {
    return "png";
  }

  return fromDataUrl.toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";
}

function normalizeImageFilename(image, index, usedNames) {
  const extension = getImageExtension(image);
  const originalName = sanitizeFilename((image.name || "").replace(/\.[a-z0-9]{1,8}$/i, ""));
  const base = originalName || "image-" + String(index + 1).padStart(2, "0");
  let filename = base + "." + extension;
  let duplicateIndex = 2;

  while (usedNames.has(filename.toLowerCase())) {
    filename = base + "-" + duplicateIndex + "." + extension;
    duplicateIndex += 1;
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

export function getNoteImages(note) {
  const usedNames = new Set();
  const images = [];

  (note.canvasItems ?? []).forEach((item) => {
    if (item.type !== "image") {
      return;
    }

    (item.images ?? []).forEach((image) => {
      images.push({
        image,
        item,
        filename: normalizeImageFilename(image, images.length, usedNames)
      });
    });
  });

  if (images.length > 0) {
    return images;
  }

  (note.images ?? []).forEach((block) => {
    (block.images ?? []).forEach((image) => {
      images.push({
        image,
        item: block,
        filename: normalizeImageFilename(image, images.length, usedNames)
      });
    });
  });

  return images;
}

function getNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getImageTextBlock(entry) {
  const caption = entry.item?.caption?.trim();
  const note = entry.item?.note?.trim();
  const x = Math.round(getNumber(entry.item?.x, 0));
  const y = Math.round(getNumber(entry.item?.y, 0));
  const lines = ["[이미지: images/" + entry.filename + "]"];

  if (entry.item && ("x" in entry.item || "y" in entry.item)) {
    lines.push("위치: x=" + x + ", y=" + y);
  }

  if (caption) {
    lines.push("캡션: " + caption);
  }

  if (note) {
    lines.push("메모: " + note);
  }

  return lines.join("\n");
}

export function buildTextExport(note, imageEntries = getNoteImages(note)) {
  const tags = note.tags?.length ? "\n\n태그: " + note.tags.map((tag) => "#" + tag).join(" ") : "";
  const title = note.title?.trim() || getFirstContentLine(note) || "제목 없음";
  const canvasItems = Array.isArray(note.canvasItems) ? [...note.canvasItems] : [];

  if (canvasItems.length > 0) {
    const imageByItem = new Map();
    imageEntries.forEach((entry) => {
      const itemId = entry.item?.id;
      if (!itemId) {
        return;
      }

      if (!imageByItem.has(itemId)) {
        imageByItem.set(itemId, []);
      }
      imageByItem.get(itemId).push(entry);
    });

    const blocks = canvasItems
      .sort((a, b) => getNumber(a.y, 0) - getNumber(b.y, 0) || getNumber(a.x, 0) - getNumber(b.x, 0))
      .map((item) => {
        if (item.type === "image") {
          return (imageByItem.get(item.id) ?? []).map(getImageTextBlock).join("\n\n");
        }

        return (item.text ?? "").trim();
      })
      .filter(Boolean);

    return title + "\n\n" + blocks.join("\n\n") + tags;
  }

  const legacyImageBlocks = imageEntries.map(getImageTextBlock).join("\n\n");
  return title + "\n\n" + [note.content, legacyImageBlocks].filter((value) => value?.trim()).join("\n\n") + tags;
}

function dataUrlToUint8Array(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    return new TextEncoder().encode(dataUrl);
  }

  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";

  if (!isBase64) {
    return new TextEncoder().encode(decodeURIComponent(data));
  }

  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function getCrc32(bytes) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function createWriter() {
  const chunks = [];
  let length = 0;

  return {
    get length() {
      return length;
    },
    writeUint16(value) {
      const bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, value, true);
      chunks.push(bytes);
      length += bytes.length;
    },
    writeUint32(value) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
      chunks.push(bytes);
      length += bytes.length;
    },
    writeBytes(bytes) {
      chunks.push(bytes);
      length += bytes.length;
    },
    toBlob(type) {
      return new Blob(chunks, { type });
    }
  };
}

function getZipDateParts(dateValue) {
  const date = new Date(dateValue || Date.now());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = Math.max(1, date.getDate());
  const zipDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | day;
  return { time, date: zipDate };
}

export function buildZipBlob(files, timestamp = Date.now()) {
  const writer = createWriter();
  const centralRecords = [];
  const encoder = new TextEncoder();
  const { time, date } = getZipDateParts(timestamp);

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
    const crc = getCrc32(data);
    const localOffset = writer.length;

    writer.writeUint32(0x04034b50);
    writer.writeUint16(20);
    writer.writeUint16(0x0800);
    writer.writeUint16(0);
    writer.writeUint16(time);
    writer.writeUint16(date);
    writer.writeUint32(crc);
    writer.writeUint32(data.length);
    writer.writeUint32(data.length);
    writer.writeUint16(nameBytes.length);
    writer.writeUint16(0);
    writer.writeBytes(nameBytes);
    writer.writeBytes(data);

    centralRecords.push({ nameBytes, dataLength: data.length, crc, localOffset });
  });

  const centralStart = writer.length;
  centralRecords.forEach((record) => {
    writer.writeUint32(0x02014b50);
    writer.writeUint16(20);
    writer.writeUint16(20);
    writer.writeUint16(0x0800);
    writer.writeUint16(0);
    writer.writeUint16(time);
    writer.writeUint16(date);
    writer.writeUint32(record.crc);
    writer.writeUint32(record.dataLength);
    writer.writeUint32(record.dataLength);
    writer.writeUint16(record.nameBytes.length);
    writer.writeUint16(0);
    writer.writeUint16(0);
    writer.writeUint16(0);
    writer.writeUint16(0);
    writer.writeUint32(0);
    writer.writeUint32(record.localOffset);
    writer.writeBytes(record.nameBytes);
  });

  const centralSize = writer.length - centralStart;
  writer.writeUint32(0x06054b50);
  writer.writeUint16(0);
  writer.writeUint16(0);
  writer.writeUint16(centralRecords.length);
  writer.writeUint16(centralRecords.length);
  writer.writeUint32(centralSize);
  writer.writeUint32(centralStart);
  writer.writeUint16(0);

  return writer.toBlob("application/zip");
}

export function buildImageFiles(imageEntries) {
  return imageEntries.map((entry) => ({
    name: "images/" + entry.filename,
    data: dataUrlToUint8Array(entry.image.src || "")
  }));
}
