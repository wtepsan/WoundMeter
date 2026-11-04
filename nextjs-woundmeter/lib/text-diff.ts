// Word-level comparison of a current text and an AI suggestion, used only to highlight changes.
// Thai is written without spaces between words, so tokens come from Intl.Segmenter when available.
// Loaded by unit tests through a plain TypeScript transpile: no imports from "@/".

export type DiffPart = { text: string; kind: "same" | "added" | "removed" };

type WordSegmenter = new (locale?: string, options?: { granularity: "word" }) => {
  segment(text: string): Iterable<{ segment: string }>;
};

export function tokenize(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenter }).Segmenter;
  if (typeof Segmenter === "function") {
    return Array.from(new Segmenter(undefined, { granularity: "word" }).segment(text), (part) => part.segment);
  }
  return text.split(/(\s+)/).filter(Boolean);
}

// Above this many comparison cells the texts are shown side by side without highlighting.
const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence diff over words; null when the texts are too long to compare cheaply. */
export function diffWords(before: string, after: string): DiffPart[] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) return null;

  const n = midA.length;
  const m = midB.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (text: string, kind: DiffPart["kind"]) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  push(a.slice(0, start).join(""), "same");
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      push(midA[i++], "same");
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(midA[i++], "removed");
    } else {
      push(midB[j++], "added");
    }
  }
  while (i < n) push(midA[i++], "removed");
  while (j < m) push(midB[j++], "added");
  push(a.slice(endA).join(""), "same");
  return parts;
}

/** Number of words added and removed (whitespace and punctuation are not counted). */
export function changeCounts(parts: DiffPart[]): { added: number; removed: number } {
  const words = (text: string) => tokenize(text).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return parts.reduce(
    (acc, part) => (part.kind === "same" ? acc : { ...acc, [part.kind]: acc[part.kind] + words(part.text) }),
    { added: 0, removed: 0 },
  );
}
