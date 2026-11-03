/**
 * Configures pdf.js once for every PDF renderer (the viewer and the thumbnail). Import this module for its side
 * effect before rendering a `Document`. The worker is emitted by Vite as a hashed asset: `new URL("pdfjs-dist/…",
 * import.meta.url)` would resolve relative to this package, where the file does not exist. The `pdfjs-dist` dependency
 * must stay at exactly the version react-pdf depends on, or the API and the worker disagree.
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { pdfjs } from "react-pdf";
