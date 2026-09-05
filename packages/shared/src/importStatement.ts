/**
 * Bank statement PDFs ride through the screenshot-import job as TEXT PAGES: the browser extracts
 * each page's text (pdf.js), and every page becomes one "image" position — a `data:text/plain`
 * URL instead of a JPEG. Windows, retries, checkpoints, the E2EE runner and the review are the
 * screenshot pipeline's, untouched; only the extraction prompt differs (text, not vision).
 * Pure helpers here; the prompt lives in aiPrompts.ts like every other prompt.
 */

export const IMPORT_TEXT_PAGE_PREFIX = "data:text/plain;base64,";

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (encoded: string): string => new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));

export function encodeImportTextPage(text: string): string {
  return `${IMPORT_TEXT_PAGE_PREFIX}${toBase64(text)}`;
}

export function isImportTextPage(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(IMPORT_TEXT_PAGE_PREFIX);
}

/** The page's text, or null when the value is not a text page. */
export function decodeImportTextPage(value: string): string | null {
  if (!isImportTextPage(value)) return null;
  try {
    return fromBase64(value.slice(IMPORT_TEXT_PAGE_PREFIX.length));
  } catch {
    return null;
  }
}

export interface PositionedText {
  str: string;
  x: number;
  y: number;
}

/**
 * pdf.js hands back text in draw order with positions, not lines. Items whose baselines lie
 * within `tolerance` of each other form one line, ordered left to right; lines run top to
 * bottom (PDF y grows upward). Column gaps are kept as double spaces so a statement's
 * amount/balance columns stay separable by eye and by model.
 */
export function statementLinesFromTextItems(items: ReadonlyArray<PositionedText>, tolerance = 2.5): string[] {
  const rows: Array<{ y: number; items: PositionedText[] }> = [];
  for (const item of items) {
    if (item.str.trim() === "") continue;
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) =>
      row.items
        .sort((left, right) => left.x - right.x)
        .map((item) => item.str.trim())
        .join("  "),
    );
}

/** An IBAN (with or without spaces) or a bare domestic account number: 20+ digits in a row. */
const ACCOUNT_NUMBER = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){3,8}\b|\b\d{20,34}\b/g;
const BANK_CODE_LINE = /\b(BIC|SWIFT|SORT CODE)\b/i;
/** A BIC/SWIFT code: 6 letters, 2 alphanumerics, optional 3-character branch. */
const BANK_CODE = /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;

/**
 * What a statement header says about the account itself never describes a transaction and
 * identifies the holder to whoever reads the prompt. Account numbers and bank codes are
 * replaced IN PLACE: a statement header is a table, and the same line that names the IBAN
 * carries the column with the opening or closing balance. Names and addresses are not
 * pattern-shaped and stay — the same trade-off the screenshots make.
 */
export function redactStatementPage(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const withoutAccounts = line.replace(ACCOUNT_NUMBER, "[account]");
      return BANK_CODE_LINE.test(withoutAccounts) ? withoutAccounts.replace(BANK_CODE, "[bank]") : withoutAccounts;
    })
    .join("\n");
}
