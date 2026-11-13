/**
 * Configures pdf.js once for every PDF renderer (the viewer and the thumbnail). Import this module for its side
 * effect before rendering a `Document`. The worker is emitted by Vite as a hashed asset: `new URL("pdfjs-dist/…",
 * import.meta.url)` would resolve relative to this package, where the file does not exist. The `pdfjs-dist` dependency
 * must stay at exactly the version react-pdf depends on, or the API and the worker disagree.
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfWorker = InstanceType<typeof pdfjs.PDFWorker>;

const shared: { options?: { worker: PdfWorker } } = {};

/**
 * The `options` every `Document` gets, so all of them share one pdf.js worker. Without it pdf.js starts a Web Worker
 * for each document (each thumbnail in a thread) and terminates it with the document. A worker passed in this way is
 * not the document's to destroy, so it stays up for the next one. Created on first use, and the same object every
 * time, which react-pdf needs to keep a loaded document.
 */
export const sharedPdfOptions = (): { worker: PdfWorker } => {
    if (!shared.options || shared.options.worker.destroyed) {
        shared.options = { worker: new pdfjs.PDFWorker() };
    }

    return shared.options;
};
