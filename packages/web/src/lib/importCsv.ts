import { type CsvTable, findCsvTable, IMPORT_CSV_MAX_BYTES, parseCsv } from "@enveo/shared";

export const isCsvFile = (file: File): boolean => file.type === "text/csv" || /\.(csv|tsv|txt)$/i.test(file.name);

const decodeWindows1250 = (bytes: Uint8Array): string => new TextDecoder("windows-1250").decode(bytes);

/** Polish banks still export Windows-1250; anything that is not valid UTF-8 is read as that. */
export function decodeCsvBytes(bytes: Uint8Array, decodeLegacy = decodeWindows1250): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeLegacy(bytes);
  }
}

export async function readCsvFile(file: Blob): Promise<CsvTable> {
  if (file.size > IMPORT_CSV_MAX_BYTES) throw new Error("csv_too_large");
  const table = findCsvTable(parseCsv(decodeCsvBytes(new Uint8Array(await file.arrayBuffer()))));
  if (!table) throw new Error("csv_without_table");
  return table;
}
