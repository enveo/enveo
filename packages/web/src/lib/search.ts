/** Pure, I/O-free matching logic behind every picker sheet's search box (envelopes, accounts,
 *  Transactions filter grid, widget "picked" checklists). Kept separate from the components so it
 *  can be unit-tested without React — see search.test.ts. */

// Combining-marks range fallback for engines without \p{Diacritic} support (verified bun 1.3/ICU 75
// DOES support it — see search.test.ts — but this keeps the function inert instead of throwing
// if it ever runs somewhere that doesn't). The range is written as \u escapes, NOT literal
// combining characters: a literal range dies with "Range out of order" the moment the file is
// served/decoded under a non-UTF-8 charset (bit us when bundling for external tooling).
const DIACRITIC_RE = (() => {
  try {
    // biome-ignore lint/complexity/useRegexLiterals: the constructor is the point — a literal fails at PARSE time, where this try/catch cannot reach it
    return new RegExp("\\p{Diacritic}", "gu");
  } catch {
    return /[\u0300-\u036f]/g;
  }
})();

const SEARCH_FOLDS: Readonly<Record<string, string>> = {
  Ł: "l",
  ł: "l",
  Đ: "d",
  đ: "d",
  Ø: "o",
  ø: "o",
  Æ: "ae",
  æ: "ae",
  Œ: "oe",
  œ: "oe",
  ẞ: "ss",
  ß: "ss",
};
const SEARCH_FOLD_RE = /[ŁłĐđØøÆæŒœẞß]/g;

/** Lowercase + strip diacritics (NFD decompose, drop combining marks) — the primary locale is
 *  Polish, so "oszczednosci" must match "Oszczędności", "zabka" → "Żabka", "lodz" → "Łódź".
 *  A small explicit fold covers letters such as ł/ß/œ that Unicode NFD does not decompose. */
export function normalizeForSearch(s: string): string {
  return s
    .replace(SEARCH_FOLD_RE, (letter) => SEARCH_FOLDS[letter] ?? letter)
    .normalize("NFD")
    .replace(DIACRITIC_RE, "")
    .toLowerCase();
}

/** Diacritic- and case-insensitive substring match. Empty/whitespace query matches everything —
 *  callers don't need to special-case "no query yet". */
export function matchesSearch(text: string, query: string): boolean {
  const q = normalizeForSearch(query.trim());
  if (!q) return true;
  return normalizeForSearch(text).includes(q);
}

/** Split ORIGINAL text (keeping its own diacritics/casing) into segments marking the matched
 *  span(s), for the UI to bold/tint. Index-safe against NFD changing character count: normalizing
 *  per ORIGINAL character (not the whole string at once) and accumulating a start-offset per
 *  character lets us map a match found in the normalized string back to the exact original
 *  characters it came from, instead of slicing the original string by a normalized-string index
 *  (which would drift as soon as any character decomposes to more than one normalized character —
 *  e.g. "Ś" → "s" + a combining acute, 1 original character but 2 normalized ones). */
export function highlightRanges(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = normalizeForSearch(query.trim());
  const chars = Array.from(text);
  if (!q || chars.length === 0) return [{ text, hit: false }];

  // boundaries[i] = start index (in `normalized`) of original character i;
  // boundaries[chars.length] = normalized.length (sentinel, so ranges are always [boundaries[i], boundaries[i+1])).
  let normalized = "";
  const boundaries: number[] = [0];
  for (const ch of chars) {
    normalized += normalizeForSearch(ch);
    boundaries.push(normalized.length);
  }

  // largest i such that boundaries[i] <= pos — the original character containing normalized position `pos`.
  const floorCharIndex = (pos: number): number => {
    let i = 0;
    while (i + 1 < boundaries.length && boundaries[i + 1]! <= pos) i++;
    return i;
  };
  // smallest i such that boundaries[i] >= pos — an exclusive "up to" original character index.
  const ceilCharIndex = (pos: number): number => {
    let i = 0;
    while (i < boundaries.length && boundaries[i]! < pos) i++;
    return i;
  };

  const segments: Array<{ text: string; hit: boolean }> = [];
  let charIdx = 0; // next original character index not yet emitted into a segment
  let searchFrom = 0; // search cursor in `normalized`
  for (;;) {
    const pos = normalized.indexOf(q, searchFrom);
    if (pos === -1) break;
    const end = pos + q.length;
    const startCharIdx = floorCharIndex(pos);
    const endCharIdx = Math.min(chars.length, ceilCharIndex(end));
    if (startCharIdx > charIdx) segments.push({ text: chars.slice(charIdx, startCharIdx).join(""), hit: false });
    segments.push({ text: chars.slice(startCharIdx, endCharIdx).join(""), hit: true });
    charIdx = endCharIdx;
    searchFrom = end;
  }
  if (charIdx < chars.length) segments.push({ text: chars.slice(charIdx).join(""), hit: false });
  return segments.length ? segments : [{ text, hit: false }];
}

/** Only show a picker's search box once the list is long enough to actually need filtering — a
 *  3-account list must not grow a search box just because the feature exists. Lives here (not
 *  per-screen) so retuning it can never leave the pickers disagreeing with each other. */
export const SEARCH_THRESHOLD = 6;
