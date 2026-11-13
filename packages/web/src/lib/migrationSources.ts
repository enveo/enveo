import { ActualExportError, type ActualTables, type FourGroszeExport, parseFourGroszeExport, parseYnabPlan, type YnabPlan } from "@enveo/shared";

/** The part of sql.js used here, kept narrow so the engine stays one adapter. */
export interface SqliteReader {
  rows(sql: string): Array<Record<string, unknown>>;
  close(): void;
}
export type OpenSqlite = (bytes: Uint8Array) => Promise<SqliteReader>;

/** sql.js and its WebAssembly are only fetched by someone importing an Actual export. */
const openWithSqlJs: OpenSqlite = async (bytes) => {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]);
  const engine = await initSqlJs({ locateFile: () => wasmUrl });
  const database = new engine.Database(bytes);
  return {
    rows(sql) {
      const statement = database.prepare(sql);
      const rows: Array<Record<string, unknown>> = [];
      while (statement.step()) rows.push(statement.getAsObject());
      statement.free();
      return rows;
    },
    close: () => database.close(),
  };
};

/** Past these sizes a tab runs out of memory, and a zip can claim anything about its own contents. */
const MIGRATION_FILE_MAX_BYTES = 256 * 1024 * 1024;
const ZIP_ENTRY_MAX_BYTES = 1024 * 1024 * 1024;

export class MigrationFileTooLarge extends Error {
  constructor() {
    super("migration_file_too_large");
    this.name = "MigrationFileTooLarge";
  }
}

async function inflateWithinLimit(packed: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([packed.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new MigrationFileTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Reads one file out of a zip through its central directory, the only place sizes are reliable. */
export async function readZipEntry(zip: Uint8Array, wanted: string, limit = ZIP_ENTRY_MAX_BYTES): Promise<Uint8Array | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  for (let index = 0; index < count && cursor + 46 <= zip.length; index++) {
    if (view.getUint32(cursor, true) !== DIRECTORY_ENTRY) return null;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeader = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === wanted) {
      if (view.getUint32(localHeader, true) !== LOCAL_HEADER) return null;
      const start = localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
      const packed = zip.subarray(start, start + compressedSize);
      if (method === STORED) return packed;
      if (method !== DEFLATED) return null;
      return inflateWithinLimit(packed, limit);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

export async function readActualExport(file: Blob, open: OpenSqlite = openWithSqlJs): Promise<ActualTables> {
  if (file.size > MIGRATION_FILE_MAX_BYTES) throw new MigrationFileTooLarge();
  const zip = new Uint8Array(await file.arrayBuffer());
  const database = await readZipEntry(zip, "db.sqlite");
  const metadata = await readZipEntry(zip, "metadata.json");
  if (!database || !metadata) throw new ActualExportError("not_an_actual_export");
  let reader: SqliteReader;
  try {
    reader = await open(database);
  } catch {
    throw new ActualExportError("not_an_actual_export");
  }
  try {
    const tableRows = <T>(sql: string) => reader.rows(sql) as T[];
    const { budgetName } = JSON.parse(new TextDecoder().decode(metadata)) as { budgetName?: string };
    return {
      budgetName: budgetName ?? "Actual",
      accounts: tableRows("SELECT id, name, offbudget, closed, tombstone, type, sort_order FROM accounts"),
      groups: tableRows("SELECT id, name, is_income, hidden, tombstone, sort_order FROM category_groups"),
      categories: tableRows("SELECT id, name, is_income, cat_group, hidden, tombstone, sort_order FROM categories"),
      categoryMapping: tableRows("SELECT id, transferId FROM category_mapping"),
      payees: tableRows("SELECT id, name, transfer_acct FROM payees WHERE tombstone = 0"),
      payeeMapping: tableRows("SELECT id, targetId FROM payee_mapping"),
      transactions: tableRows(
        "SELECT id, isParent, isChild, parent_id, acct, category, amount, description, notes, date, transferred_id, tombstone FROM transactions",
      ),
      budgets: tableRows("SELECT month, category, amount, carryover FROM zero_budgets"),
      preferences: tableRows("SELECT id, value FROM preferences"),
    };
  } catch (error) {
    if (error instanceof SyntaxError || (error as { message?: string }).message?.includes("no such")) throw new ActualExportError("not_an_actual_export");
    throw error;
  } finally {
    reader.close();
  }
}

export class YnabRequestError extends Error {
  constructor(readonly status: number) {
    super(`ynab_${status}`);
    this.name = "YnabRequestError";
  }
}

const YNAB_API = "https://api.ynab.com/v1";

/** The token goes from this browser straight to YNAB and is never stored or sent to Enveo's server. */
async function ynabGet(token: string, path: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(`${YNAB_API}${path}`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (!response.ok) throw new YnabRequestError(response.status);
  return response.json();
}

export interface YnabPlanSummary {
  id: string;
  name: string;
}

export async function listYnabPlans(token: string, fetcher: typeof fetch = fetch): Promise<YnabPlanSummary[]> {
  const body = (await ynabGet(token, "/plans", fetcher)) as { data?: { plans?: YnabPlanSummary[] } };
  return body.data?.plans ?? [];
}

export async function fetchYnabPlan(token: string, id: string, fetcher: typeof fetch = fetch): Promise<YnabPlan> {
  return parseYnabPlan(await ynabGet(token, `/plans/${encodeURIComponent(id)}`, fetcher));
}

async function readJsonFile(file: Blob): Promise<unknown> {
  if (file.size > MIGRATION_FILE_MAX_BYTES) throw new MigrationFileTooLarge();
  try {
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

export async function readYnabFile(file: Blob): Promise<YnabPlan> {
  return parseYnabPlan(await readJsonFile(file));
}

export async function readFourGroszeFile(file: Blob): Promise<FourGroszeExport> {
  return parseFourGroszeExport(await readJsonFile(file));
}
