import { encodeImportTextPage, redactStatementPage, statementLinesFromTextItems } from "@enveo/shared";
import "./pdfPolyfills";

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
  // The LEGACY build: the modern one assumes the newest engines (Promise.withResolvers and
  // friends), which the iPhone this app lives on does not guarantee; legacy is transpiled and
  // polyfilled, and it is a lazy chunk either way.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Our own worker entry (pdfWorker.ts) runs the same polyfills BEFORE pdf.js's worker code; a
  // worker started from pdf.js's own file would lack them and hang the import on older engines.
  // A classic (non-module) worker so engines without module workers (Firefox < 114) load it too.
  const worker = new Worker(new URL("./pdfWorker.ts", import.meta.url));
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= Math.min(document.numPages, PDF_MAX_PAGES); number += 1) {
      const page = await document.getPage(number);
      const items = (await readTextItems(page)).flatMap((item) => ("str" in item ? [{ str: item.str, x: item.transform[4]!, y: item.transform[5]! }] : []));
      const text = redactStatementPage(statementLinesFromTextItems(items).join("\n"));
      if (text.trim() !== "") pages.push(encodeImportTextPage(text));
    }
    await task.destroy();
    if (pages.length === 0) throw new PdfWithoutTextError();
    return pages;
  } finally {
    pdfjs.GlobalWorkerOptions.workerPort = null;
    worker.terminate();
  }
}

/**
 * `page.getTextContent()` iterates its ReadableStream with `for await`, and Safari before 26
 * (iOS 18 included) has no `Symbol.asyncIterator` on streams — "undefined is not a function
 * (near '...i of e...')" on the phone this app lives on. A reader works everywhere.
 */
async function readTextItems(page: { streamTextContent(): ReadableStream<{ items: unknown[] }> }) {
  const reader = page.streamTextContent().getReader();
  const items: TextItem[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(...(value.items as TextItem[]));
  }
}

type TextItem = { str: string; transform: number[] } | { type: string };
