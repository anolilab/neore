/**
 * Build the FAL input fragment for the supplied reference image URLs.
 *
 * Mirrors `backend/lunora/chat/lib/reference-image-mapping.ts` — the FAL endpoints
 * accept `image_url: string` (single-ref) and additionally `image_urls: string[]`
 * for multi-ref-capable models (Nano-Banana, FLUX Redux). Single-ref-only
 * endpoints ignore extras, so we conservatively send both fields when the cap
 * is greater than one.
 *
 * Returns an empty object when the model has no reference support or the
 * caller passed no refs — callers can spread it unconditionally.
 * @param cap per-model `maxReferenceImages` ceiling. Falsy means the model
 * does not support reference images and any URLs are dropped.
 * @param referenceImages ordered URLs from the request payload. Order is
 * preserved so the badge index the user saw matches
 * the FAL request.
 */
export const buildFalReferenceImageInput = (
    cap: number | undefined,
    referenceImages: ReadonlyArray<string> | undefined,
): { image_url?: string; image_urls?: string[] } => {
    if (!referenceImages || referenceImages.length === 0) return {};

    if (!cap || cap <= 0) return {};

    const clamped = referenceImages.slice(0, cap);
    const primary = clamped[0];

    if (!primary) return {};

    const result: { image_url?: string; image_urls?: string[] } = { image_url: primary };

    if (cap > 1 && clamped.length > 1) {
        result.image_urls = [...clamped];
    }

    return result;
};
