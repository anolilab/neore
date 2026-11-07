import { describe, expect, it } from "vitest";

import { OPEN_PDF_PREVIEW_EVENT, requestPdfPreview } from "./pdf-preview-event";

const detail = { filename: "report.pdf", url: "https://files.example.com/report.pdf" };

describe(requestPdfPreview, () => {
    it("reports not handled when nothing listens, so the caller shows its fallback", () => {
        expect(requestPdfPreview(detail, new EventTarget())).toBe(false);
    });

    it("hands the file to a listener that takes it, with the file in the event", () => {
        const target = new EventTarget();
        let received: unknown;

        target.addEventListener(OPEN_PDF_PREVIEW_EVENT, (event) => {
            received = (event as CustomEvent).detail;
            event.preventDefault();
        });

        expect(requestPdfPreview(detail, target)).toBe(true);
        expect(received).toEqual(detail);
    });

    it("counts a listener that does not take the file as not handled", () => {
        const target = new EventTarget();

        target.addEventListener(OPEN_PDF_PREVIEW_EVENT, () => {});

        expect(requestPdfPreview(detail, target)).toBe(false);
    });
});
