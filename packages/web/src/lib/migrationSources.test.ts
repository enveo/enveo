import { describe, expect, test } from "bun:test";
import { ActualExportError, FourGroszeExportError, YnabPlanError } from "@enveo/shared";
import {
  fetchYnabPlan,
  listYnabPlans,
  MigrationFileTooLarge,
  readActualExport,
  readFourGroszeFile,
  readYnabFile,
  readZipEntry,
  type SqliteReader,
  YnabRequestError,
} from "./migrationSources";

const encoder = new TextEncoder();

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip as Actual's exporter writes one: a central directory holding the real sizes. */
async function zip(files: Record<string, string>, compress = true): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const entries: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(content);
    const body = compress ? await deflate(raw) : raw;
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(10, compress ? 8 : 0, true);
    entryView.setUint32(20, body.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    locals.push(local);
    entries.push(entry);
    offset += local.length;
  }
  const directorySize = entries.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + 22);
  let cursor = 0;
  for (const part of [...locals, ...entries, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const emptyReader = (rows: Record<string, Array<Record<string, unknown>>> = {}): SqliteReader => ({
  rows: (sql) => rows[/FROM (\w+)/.exec(sql)![1]!] ?? [],
  close: () => {},
});

describe("zip entries", () => {
  test("given deflated and stored entries when read then each returns its own content", async () => {
    for (const compress of [true, false]) {
      const bytes = await zip({ "metadata.json": "{}", "db.sqlite": "database bytes" }, compress);
      expect(new TextDecoder().decode((await readZipEntry(bytes, "db.sqlite"))!)).toBe("database bytes");
    }
  });

  test("given an entry inflating past the limit when read then reading stops", async () => {
    const bomb = await zip({ "db.sqlite": "a".repeat(100_000) });
    await expect(readZipEntry(bomb, "db.sqlite", 1000)).rejects.toThrow(MigrationFileTooLarge);
  });

  test("given a file that is not a zip when read then nothing is returned", async () => {
    expect(await readZipEntry(encoder.encode("not a zip at all, sorry about that"), "db.sqlite")).toBeNull();
  });
});

describe("Actual export", () => {
  test("given an export when read then the budget name comes from its metadata", async () => {
    const file = new Blob([(await zip({ "metadata.json": '{"budgetName":"Sample household"}', "db.sqlite": "x" })).slice()]);
    const tables = await readActualExport(file, async () => emptyReader());
    expect(tables.budgetName).toBe("Sample household");
  });

  test("given a zip without a database when read then it is refused", async () => {
    const file = new Blob([(await zip({ "readme.txt": "hello" })).slice()]);
    await expect(readActualExport(file, async () => emptyReader())).rejects.toThrow(ActualExportError);
  });

  test("given a corrupt database when read then it is refused rather than crashing", async () => {
    const file = new Blob([(await zip({ "metadata.json": "{}", "db.sqlite": "x" })).slice()]);
    await expect(
      readActualExport(file, async () => {
        throw new Error("file is not a database");
      }),
    ).rejects.toThrow(ActualExportError);
  });
});

describe("YNAB requests", () => {
  const fetcher = (status: number, body: unknown, seen: Request[] = []) =>
    (async (input: string, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  test("given a token when listing then only YNAB receives it, trimmed", async () => {
    const seen: Request[] = [];
    const plans = await listYnabPlans("  secret-token\n", fetcher(200, { data: { plans: [{ id: "p1", name: "Household" }] } }, seen));
    expect(plans).toEqual([{ id: "p1", name: "Household" }]);
    expect(new URL(seen[0]!.url).origin).toBe("https://api.ynab.com");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("given a rejected token when listing then the status reaches the caller", async () => {
    await expect(listYnabPlans("bad", fetcher(401, {}))).rejects.toThrow(YnabRequestError);
  });

  test("given an unexpected answer when fetching a plan then it is refused", async () => {
    await expect(fetchYnabPlan("token", "p1", fetcher(200, { data: {} }))).rejects.toThrow(YnabPlanError);
  });

  test("given a file that is not JSON when read then it is refused", async () => {
    await expect(readYnabFile(new Blob(["not json"]))).rejects.toThrow(YnabPlanError);
  });
});

describe("4grosze.pl export", () => {
  test("given an export file when read then its rows come back as written", async () => {
    const file = { envelopes: [], accounts: [{ name: "Checking" }], budgetEntries: [], transactions: [] };
    expect(await readFourGroszeFile(new Blob([JSON.stringify(file)]))).toMatchObject({ accounts: [{ name: "Checking" }] });
  });

  test("given a YNAB file or something that is not JSON when read then it is refused", async () => {
    await expect(readFourGroszeFile(new Blob([JSON.stringify({ data: { budget: {} } })]))).rejects.toThrow(FourGroszeExportError);
    await expect(readFourGroszeFile(new Blob(["not json"]))).rejects.toThrow(FourGroszeExportError);
  });
});
