import { beforeEach, describe, expect, it } from "vitest";

import {
    cachePdfThumbnail,
    clearPdfThumbnailCache,
    MAX_CACHED_PDF_THUMBNAILS,
    pdfThumbnailCacheGeneration,
    peekCachedPdfThumbnail,
    touchCachedPdfThumbnail,
} from "./pdf-thumbnail-cache";

const keyOf = (index: number) => `https://files.example/${String(index)}.pdf`;
const drawing = (snapshot: string) => {
    return { pages: 1, snapshot };
};

/** Fills the cache, `keyOf(0)` first (the least recently used). */
const fill = () => {
    for (let index = 0; index < MAX_CACHED_PDF_THUMBNAILS; index += 1) {
        cachePdfThumbnail(keyOf(index), drawing(`data:${String(index)}`), pdfThumbnailCacheGeneration());
    }
};

/** Adds one more file, which evicts the least recently used entry. */
const addOneMore = () => {
    cachePdfThumbnail(keyOf(MAX_CACHED_PDF_THUMBNAILS), drawing("data:new"), pdfThumbnailCacheGeneration());
};

beforeEach(() => {
    clearPdfThumbnailCache();
});

describe("the PDF thumbnail cache", () => {
    it("does not reorder on a peek", () => {
        fill();
        peekCachedPdfThumbnail(keyOf(0));
        addOneMore();

        expect(peekCachedPdfThumbnail(keyOf(0))).toBeUndefined();
    });

    it("marks an entry used on a touch with the entry and generation it was looked up with", () => {
        fill();

        const generation = pdfThumbnailCacheGeneration();
        const entry = peekCachedPdfThumbnail(keyOf(0))!;

        touchCachedPdfThumbnail(keyOf(0), entry, generation);
        addOneMore();

        expect(peekCachedPdfThumbnail(keyOf(0))).toBe(entry);
        expect(peekCachedPdfThumbnail(keyOf(1))).toBeUndefined();
    });

    it("leaves the order alone when the entry was drawn again since the lookup", () => {
        fill();

        const generation = pdfThumbnailCacheGeneration();
        const stale = peekCachedPdfThumbnail(keyOf(0))!;

        // A newer drawing of file 0, then file 1 is used, which leaves file 0 the oldest again.
        cachePdfThumbnail(keyOf(0), drawing("data:redrawn"), generation);

        for (let index = 1; index < MAX_CACHED_PDF_THUMBNAILS; index += 1) {
            touchCachedPdfThumbnail(keyOf(index), peekCachedPdfThumbnail(keyOf(index))!, generation);
        }

        touchCachedPdfThumbnail(keyOf(0), stale, generation);
        addOneMore();

        expect(peekCachedPdfThumbnail(keyOf(0))).toBeUndefined();
    });

    it("does not bring back an entry after a clear", () => {
        fill();

        const generation = pdfThumbnailCacheGeneration();
        const entry = peekCachedPdfThumbnail(keyOf(0))!;

        clearPdfThumbnailCache();
        touchCachedPdfThumbnail(keyOf(0), entry, generation);

        expect(peekCachedPdfThumbnail(keyOf(0))).toBeUndefined();
    });
});
