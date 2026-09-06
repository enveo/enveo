/**
 * What pdf.js 6's "legacy" build does NOT polyfill. That build is transpiled for Chrome 125,
 * Safari 18 and Firefox ESR and shims only what THOSE lack, so anything older trips on
 * `Promise.withResolvers` (Chrome 119, Firefox 121, Safari 17.4) before reading a byte — in the
 * page and, separately, in the worker. Measured on real engines (Chromium 113, Firefox 112 and
 * 119, WebKit 16.4–18.2): this one shim is the difference. Imported as a side effect by BOTH
 * pdfText.ts and pdfWorker.ts, ahead of pdf.js (static imports evaluate in order). Nothing else
 * in Enveo needs it, so it stays out of the app shell.
 */
export function installPdfPolyfills() {
  const P = Promise as unknown as { withResolvers?: unknown };
  if (typeof P.withResolvers !== "function") {
    P.withResolvers = function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
}

installPdfPolyfills();
