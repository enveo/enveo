import { IMPORT_NAME_MAX_LENGTH } from "./aiPrompts";
import { isCalendarDate } from "./dates";
import { importHistoryRecords, normalizeImportHistoryText, selectImportHistoryCandidates } from "./importHistory";
import type { ImportExtractRow, ImportProposal, ImportRecognitionResult } from "./importRecognition";
import type { ClientLedger } from "./types";

export const IMPORT_CSV_MAX_ROWS = 3000;
export const IMPORT_CSV_MAX_BYTES = 20 * 1024 * 1024;
/** Marks a job that read a file instead of asking a model. It stays a model value because every
 *  installed PWA validates the provider as a closed enum, and one unknown job would fail its whole
 *  import list. Such a job starts ready, so nothing ever runs it against a provider. */
export const IMPORT_FILE_MODEL = "csv-file";

export type CsvDateOrder = "ymd" | "dmy" | "mdy";

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export interface CsvMapping {
  date: number | null;
  /** One signed column, or the two unsigned ones many banks use instead. */
  amount: number | null;
  moneyOut: number | null;
  moneyIn: number | null;
  payee: number | null;
  description: number | null;
  dateOrder: CsvDateOrder;
}

// Comma comes last: on a tie it is the likeliest to be a decimal mark inside a cell.
const DELIMITERS = [";", "\t", "|", ","];

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else field += char;
  }
  if (field !== "" || record.length > 0) records.push([...record, field]);
  return records.filter((row) => row.some((cell) => cell.trim() !== ""));
}

const DATE_SHAPE = /^\s*(\d{1,4})[-./](\d{1,2})[-./](\d{1,4})/;

export const looksLikeDate = (cell: string): boolean => DATE_SHAPE.test(cell);

/** The width most matching rows share, which is the table: a preamble above it can be wider. */
function tableWidth(records: string[][], matches: (record: string[]) => boolean): { width: number; rows: number } {
  const widths = new Map<number, number>();
  for (const record of records) if (record.length > 1 && matches(record)) widths.set(record.length, (widths.get(record.length) ?? 0) + 1);
  let best = { width: 0, rows: 0 };
  for (const [width, rows] of widths) if (rows > best.rows || (rows === best.rows && width < best.width)) best = { width, rows };
  return best;
}

const isDated = (record: string[]): boolean => record.some(looksLikeDate);

/** A date alone also survives a wrong split, so a delimiter must leave a date and an amount in separate cells. */
const isTransaction = (record: string[]): boolean => {
  const date = record.findIndex(looksLikeDate);
  return date >= 0 && record.some((cell, index) => index !== date && parseCsvAmount(cell) !== null);
};

/**
 * The delimiter that gives the most readable rows of one shared width wins. On a tie the one whose
 * header and other rows share that width wins: a stray delimiter inside a cell splits only that row.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  let best: string[][] = [];
  let bestRows = 0;
  let bestShared = 0;
  for (const delimiter of DELIMITERS) {
    const records = splitRecords(clean, delimiter);
    const { width, rows } = tableWidth(records, isTransaction);
    const shared = records.filter((record) => record.length === width).length;
    if (rows > bestRows || (rows === bestRows && rows > 0 && shared > bestShared)) {
      best = records;
      bestRows = rows;
      bestShared = shared;
    }
  }
  return best;
}

/** Bank exports open with account details, so the table starts at the row above the first dated row of its width. */
export function findCsvTable(records: string[][]): CsvTable | null {
  const { width } = tableWidth(records, isDated);
  const firstData = records.findIndex((record) => record.length === width && isDated(record));
  if (firstData < 0) return null;
  const header = firstData > 0 && records[firstData - 1]!.length === width ? records[firstData - 1]! : null;
  return {
    headers: header ? header.map((cell) => cell.trim()) : Array.from({ length: width }, (_, index) => `#${index + 1}`),
    rows: records.slice(firstData).filter((record) => record.length === width),
  };
}

const HEADER_WORDS: Array<[keyof Omit<CsvMapping, "dateOrder">, RegExp]> = [
  ["moneyOut", /debit|withdraw|outflow|money out|paid out|obci[aą]ż|wydatek|wyp[lł]at/i],
  ["moneyIn", /credit|deposit|inflow|money in|paid in|uznani|wp[lł]yw|wp[lł]at|przych[oó]d/i],
  ["payee", /payee|merchant|counterpart|recipient|beneficiary|kontrahent|odbiorc|nadawc|sprzedawc|empf[aä]nger|b[eé]n[eé]ficiaire/i],
  ["description", /descri|memo|title|details|narrative|reference|opis|tytu[lł]|szczeg[oó]|verwendung|libell[eé]/i],
  ["amount", /amount|value|kwota|warto[sś][cć]|betrag|montant/i],
  ["date", /date|data|datum/i],
];

function dateOrderOf(cells: readonly string[]): CsvDateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const cell of cells) {
    const match = DATE_SHAPE.exec(cell);
    if (!match) continue;
    if (match[1]!.length === 4) return "ymd";
    if (Number(match[1]) > 12) dayFirst = true;
    if (Number(match[2]) > 12) monthFirst = true;
  }
  return monthFirst && !dayFirst ? "mdy" : "dmy";
}

export function suggestCsvMapping(table: CsvTable): CsvMapping {
  const mapping: CsvMapping = { date: null, amount: null, moneyOut: null, moneyIn: null, payee: null, description: null, dateOrder: "dmy" };
  table.headers.forEach((header, column) => {
    const match = HEADER_WORDS.find(([field, words]) => mapping[field] === null && words.test(header));
    if (match) mapping[match[0]] = column;
  });
  const sample = table.rows.slice(0, 20);
  const columns = table.headers.map((_, column) => column);
  mapping.date ??= columns.find((column) => sample.every((row) => looksLikeDate(row[column]!))) ?? null;
  const holdsAmounts = (column: number | null) =>
    column !== null &&
    sample.some((row) => parseCsvAmount(row[column]!) !== null) &&
    sample.every((row) => !row[column]!.trim() || parseCsvAmount(row[column]!) !== null);
  // One direction column alone (a debit-only export) keeps its direction, unless it is a debit/credit marker beside an amount.
  const separate = mapping.moneyOut !== null && mapping.moneyIn !== null;
  const oneSided = mapping.amount === null && (mapping.moneyOut === null) !== (mapping.moneyIn === null) && holdsAmounts(mapping.moneyOut ?? mapping.moneyIn);
  if (separate || oneSided) mapping.amount = null;
  else {
    mapping.amount ??= columns.find((column) => column !== mapping.date && sample.every((row) => parseCsvAmount(row[column]!) !== null)) ?? null;
    mapping.moneyOut = null;
    mapping.moneyIn = null;
  }
  if (mapping.date !== null) mapping.dateOrder = dateOrderOf(table.rows.map((row) => row[mapping.date!]!));
  return mapping;
}

const WHOLE = /^\d+$/;
const PLAIN_DECIMAL = /^(\d+)[.,](\d{1,2})$/;
const GROUPED = /^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/;
const GROUPED_DECIMAL = /^([1-9]\d{0,2}(?:([.,])\d{3})(?:\2\d{3})*)([.,])(\d{1,2})$/;

/** Only shapes with one reading pass: `12.3456` or `0.125` stop here instead of being scaled up. */
function parseMagnitude(digits: string): number | null {
  if (WHOLE.test(digits) || GROUPED.test(digits)) return Number(digits.replace(/[.,]/g, "")) * 100;
  const plain = PLAIN_DECIMAL.exec(digits);
  if (plain) return Number(plain[1]) * 100 + Number(plain[2]!.padEnd(2, "0"));
  const grouped = GROUPED_DECIMAL.exec(digits);
  if (grouped && grouped[2] !== grouped[3]) return Number(grouped[1]!.replace(/[.,]/g, "")) * 100 + Number(grouped[4]!.padEnd(2, "0"));
  return null;
}

export function parseCsvAmount(cell: string): number | null {
  const raw = cell.replace(/[\s\u00A0\u202F']/g, "");
  const shape = /^([-−–(+]?)[^\d.,-]{0,4}(\d[\d.,]*)[^\d.,]{0,4}?([-−–)]?)$/.exec(raw);
  if (!shape) return null;
  const minor = parseMagnitude(shape[2]!);
  if (minor === null || !Number.isSafeInteger(minor)) return null;
  const negative = "-−–(".includes(shape[1] || " ") || "-−–)".includes(shape[3] || " ");
  return negative ? -minor : minor;
}

export function parseCsvDate(cell: string, order: CsvDateOrder): string | null {
  const match = DATE_SHAPE.exec(cell);
  if (!match) return null;
  const [first, second, third] = [match[1]!, match[2]!, match[3]!];
  const [year, month, day] = first.length === 4 ? [first, second, third] : order === "mdy" ? [third, first, second] : [third, second, first];
  const date = `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isCalendarDate(date) ? date : null;
}

function signedAmount(row: readonly string[], mapping: CsvMapping): number | null {
  if (mapping.amount !== null) return parseCsvAmount(row[mapping.amount] ?? "");
  const out = mapping.moneyOut === null ? null : parseCsvAmount(row[mapping.moneyOut] ?? "");
  const into = mapping.moneyIn === null ? null : parseCsvAmount(row[mapping.moneyIn] ?? "");
  if (out) return -Math.abs(out);
  return into ? Math.abs(into) : null;
}

export interface CsvRow {
  index: number;
  date: string;
  amount: number;
  name: string;
  payee: string | null;
  text: string;
}

export interface CsvReading {
  rows: CsvRow[];
  unreadable: number;
}

/** A row that cannot give a date and an amount is counted, never guessed at. */
export function readCsvRows(table: CsvTable, mapping: CsvMapping): CsvReading {
  const rows: CsvRow[] = [];
  let unreadable = 0;
  const repeats = new Map<string, number>();
  table.rows.forEach((row, index) => {
    const date = mapping.date === null ? null : parseCsvDate(row[mapping.date] ?? "", mapping.dateOrder);
    const amount = signedAmount(row, mapping);
    if (!date || !amount) {
      unreadable++;
      return;
    }
    const payee = (mapping.payee === null ? "" : (row[mapping.payee] ?? "")).trim();
    const description = (mapping.description === null ? "" : (row[mapping.description] ?? "")).trim();
    const name = (payee || description).slice(0, IMPORT_NAME_MAX_LENGTH);
    const base = [payee, description].filter(Boolean).join(" ") || `${date} ${amount}`;
    // Identical rows are real (two bus tickets a day). Numbering them keeps both, and a later
    // re-import of the same file recognizes each one again instead of adding it twice.
    const key = `${date}|${amount}|${base}`;
    const occurrence = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, occurrence);
    // Dedupe compares unsigned amounts, so money in carries its direction in the reference: a
    // payment and its refund on one day are two transactions.
    const reference = amount > 0 ? `${base} (+)` : base;
    rows.push({ index, date, amount, name, payee: payee || null, text: occurrence > 1 ? `${reference} #${occurrence}` : reference });
  });
  return { rows, unreadable };
}

/** History knows names, and names repeat: one that points at two rows points at neither. */
function idsByUniqueName(rows: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const ids = new Map<string, string>();
  const repeated = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.name)) repeated.add(row.name);
    else ids.set(row.name, row.id);
  }
  for (const name of repeated) ids.delete(name);
  return ids;
}

/** What the person did with the same merchant before is the only help a file gets without AI:
 *  a confident, unconflicted match fills the envelope and category, everything else stays blank. */
export function applyCsvHistory(result: ImportRecognitionResult, ledger: ClientLedger, accountId: string, currency: string): ImportRecognitionResult {
  // A past expense left without an envelope stays in: it is what makes another envelope a conflict.
  const records = importHistoryRecords(ledger, currency).filter((record) => record.type !== "transfer");
  if (records.length === 0) return result;
  const envelopes = idsByUniqueName(ledger.envelopes.filter((envelope) => !envelope.archived));
  const categories = idsByUniqueName(ledger.categories.filter((category) => !category.archived));
  const ownedAccountIds = ledger.accounts.map((account) => account.id);
  const known = new Map<string, Pick<ImportProposal, "envelopeId" | "categoryId">>();
  return {
    ...result,
    proposals: result.proposals.map((proposal) => {
      if (proposal.type !== "expense") return proposal;
      // The selector reads the whole descriptor, so two rows of one payee can still match differently.
      const key = `${proposal.tag}\u0000${proposal.rawPlace}`;
      let found = known.get(key);
      if (!found) {
        const { candidates, conflict } = selectImportHistoryCandidates({ accountId, ownedAccountIds, proposal }, records, 1);
        const best = conflict ? undefined : candidates[0];
        const confident = best && best.match !== "fuzzy_similarity" && best.match !== "source_similarity";
        found = {
          envelopeId: confident && best.envelope ? (envelopes.get(best.envelope) ?? null) : null,
          categoryId: confident && best.category ? (categories.get(best.category) ?? null) : null,
        };
        known.set(key, found);
      }
      return { ...proposal, ...found };
    }),
  };
}

export function csvRowsToRecognition(rows: readonly CsvRow[], currency: string): ImportRecognitionResult {
  const extract: ImportExtractRow[] = rows.map((row) => ({
    rowId: `r${row.index}`,
    imageIndex: 0,
    visualOrder: row.index,
    rawTextLines: [row.text],
    date: row.date,
    amount: Math.abs(row.amount),
    currency,
    direction: row.amount < 0 ? "debit" : "credit",
    postingStatus: "posted",
    rowRole: "financial_event",
    semanticKind: "unknown",
    relation: null,
    confidence: "high",
    reviewReasons: [],
  }));
  const proposals: ImportProposal[] = rows.map((row) => ({
    rowId: `r${row.index}`,
    sourceRows: [`r${row.index}`],
    disposition: "candidate",
    date: row.date,
    amount: Math.abs(row.amount),
    currency,
    type: row.amount < 0 ? "expense" : "income",
    isRefund: false,
    toAccountId: null,
    semanticKind: "unknown",
    relation: null,
    name: row.name,
    tag: normalizeImportHistoryText(row.payee ?? row.name),
    rawPlace: row.text,
    envelopeId: null,
    categoryId: null,
    placeName: row.payee,
    reviewReasons: [],
    selected: true,
  }));
  return { rows: extract, proposals };
}
