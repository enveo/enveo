// The pdf.js worker with Enveo's polyfills in front of it. Order matters: ES module imports are
// evaluated in source order, so pdfPolyfills runs before the first line of pdf.js's worker code.
import "./pdfPolyfills";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
