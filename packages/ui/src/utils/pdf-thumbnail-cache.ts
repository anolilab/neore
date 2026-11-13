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

/** Bumped by every clear: a draw that started before it belongs to the session that ended. */
const cacheState = { generation: 0 };

/** The cache's current generation; a thumbnail takes it when its draw starts and hands it back with the result. */
export const pdfThumbnailCacheGeneration = (): number => cacheState.generation;

export const getCachedPdfThumbnail = (fileKey: string): CachedPdfThumbnail | undefined => {
    const cached = thumbnails.get(fileKey);

    if (cached) {
        thumbnails.delete(fileKey);
        thumbnails.set(fileKey, cached);
    }

    return cached;
};

/**
 * Keeps a drawn thumbnail, unless the cache was cleared since its draw started (`generation`): a page drawn for the
 * account that signed out must not be shown to the next one, which the file key alone (no signature) would allow.
 */
export const cachePdfThumbnail = (fileKey: string, thumbnail: CachedPdfThumbnail, generation: number): void => {
    if (generation !== cacheState.generation) {
        return;
    }

    thumbnails.delete(fileKey);
    thumbnails.set(fileKey, thumbnail);

    const oldest = thumbnails.size > MAX_CACHED_PDF_THUMBNAILS ? thumbnails.keys().next().value : undefined;

    if (oldest !== undefined) {
        thumbnails.delete(oldest);
    }
};

/** Drops every cached thumbnail: they were drawn from files of the session that ended. */
export const clearPdfThumbnailCache = (): void => {
    cacheState.generation += 1;
    thumbnails.clear();
};
