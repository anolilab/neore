/**
 * Drawn PDF thumbnails, kept so a thumbnail that mounts again (scrolled back into view, a re-signed URL, a thread
 * opened again) shows its image at once instead of loading and drawing the PDF again. Keyed by the file
 * (`pdfFileKey`), not the signed URL. Bounded: the least recently used entry goes first.
 */

export interface CachedPdfThumbnail {
    pages: number;
    /** The first page as a PNG data URL. */
    snapshot: string;
}

/** A 200px-wide page is tens of KB as a data URL; this many stays a few MB at most. */
export const MAX_CACHED_PDF_THUMBNAILS = 32;

const thumbnails = new Map<string, CachedPdfThumbnail>();

export const getCachedPdfThumbnail = (fileKey: string): CachedPdfThumbnail | undefined => {
    const cached = thumbnails.get(fileKey);

    if (cached) {
        thumbnails.delete(fileKey);
        thumbnails.set(fileKey, cached);
    }

    return cached;
};

export const cachePdfThumbnail = (fileKey: string, thumbnail: CachedPdfThumbnail): void => {
    thumbnails.delete(fileKey);
    thumbnails.set(fileKey, thumbnail);

    const oldest = thumbnails.size > MAX_CACHED_PDF_THUMBNAILS ? thumbnails.keys().next().value : undefined;

    if (oldest !== undefined) {
        thumbnails.delete(oldest);
    }
};

/** Drops every cached thumbnail: they were drawn from files of the session that ended. */
export const clearPdfThumbnailCache = (): void => {
    thumbnails.clear();
};
