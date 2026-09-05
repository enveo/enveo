import { encodeImportTextPage, redactStatementPage, statementLinesFromTextItems } from "@enveo/shared";

export const PDF_MAX_PAGES = 30;

export class PdfWithoutTextError extends Error {
  constructor() {
    super("pdf_without_text");
    this.name = "PdfWithoutTextError";
  }
}

/**
 * A statement PDF becomes one text page per PDF page, each redacted and encoded as the
 * `data:text/plain` "image" the import job accepts. pdf.js loads lazily: it is far larger than
 * the whole app shell and only a PDF import ever needs it. A PDF without a text layer (a scan)
 * is refused — the screenshots path is the one for pictures.
 */
export async function statementPagesFromPdf(file: File): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await task.promise;
  const pages: string[] = [];
  for (let number = 1; number <= Math.min(document.numPages, PDF_MAX_PAGES); number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => ("str" in item ? [{ str: item.str, x: item.transform[4]!, y: item.transform[5]! }] : []));
    const text = redactStatementPage(statementLinesFromTextItems(items).join("\n"));
    if (text.trim() !== "") pages.push(encodeImportTextPage(text));
  }
  await task.destroy();
  if (pages.length === 0) throw new PdfWithoutTextError();
  return pages;
}
