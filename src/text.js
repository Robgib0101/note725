export const templates = {
  daily: "## 오늘 기록\n\n- 좋았던 일:\n- 배운 점:\n- 내일 할 일:\n",
  meeting: "## 회의록\n\n- 일시:\n- 참석자:\n- 논의 내용:\n- 결정 사항:\n- 다음 작업:\n",
  idea: "## 아이디어\n\n문제:\n\n해결 방향:\n\n다음 실험:\n",
  tasks: "## 작업 목록\n\n- [ ] \n- [ ] \n- [ ] \n"
};

export function formatDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function getTitle(note) {
  return note.title.trim() || note.content.trim().split("\n")[0] || "제목 없음";
}

export function getPreview(note) {
  const preview = note.content.replace(/\s+/g, " ").trim();

  return preview || "내용 없음";
}

export function getSearchText(note) {
  return [note.title, note.content, ...(note.tags ?? [])].join(" ").toLowerCase();
}

export function parseTags(value) {
  return value
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

export function getImageCount(note) {
  return note?.images?.reduce((total, block) => total + (block.images?.length ?? 1), 0) ?? 0;
}

export function getContentStats(content, images = 0) {
  const trimmed = content.trim();
  const chars = content.length;
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const lines = content ? content.split("\n").length : 1;
  const checks = (content.match(/- \[[ xX]\] /g) ?? []).length;
  const done = (content.match(/- \[[xX]\] /g) ?? []).length;
  const readMinutes = Math.max(1, Math.ceil(words / 220));

  return {
    chars,
    words,
    lines,
    checks,
    done,
    images,
    readLabel: readMinutes === 1 ? "1분 미만" : readMinutes + "분"
  };
}

export function getSafeFilename(title, extension) {
  const filename = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);

  return (filename || "note") + extension;
}
