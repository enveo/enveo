import { describe, expect, test } from "bun:test";
import { decodeCsvBytes, isCsvFile, readCsvFile } from "./importCsv";

describe("CSV files", () => {
  test("given bytes that are not UTF-8 when decoded then the legacy decoder reads them", () => {
    expect(decodeCsvBytes(new Uint8Array([0x5a, 0xbf]), () => "legacy")).toBe("legacy");
  });

  test("given UTF-8 bytes when decoded then they are read as UTF-8", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("Zażółć"))).toBe("Zażółć");
  });

  test("given a file with no dated rows when read then it is refused", async () => {
    await expect(readCsvFile(new Blob(["just,some,text\nwithout,any,dates\n"]))).rejects.toThrow("csv_without_table");
  });

  test("given a name or a type when checked then csv files are recognized", () => {
    expect(isCsvFile(new File([], "history.CSV"))).toBe(true);
    expect(isCsvFile(new File([], "export", { type: "text/csv" }))).toBe(true);
    expect(isCsvFile(new File([], "statement.pdf"))).toBe(false);
  });
});
