import type { ModelDefinition } from "@neore/ai/models";

/**
 * FAL endpoint -> reference-image field mapping for the multi-reference image picker.
 *
 * FAL's image-generation endpoints diverge on how they accept reference URLs:
 *
 * - Multi-ref-capable models (Nano-Banana family, FLUX Pro Redux) accept
 *   `image_urls: string[]` for the full ordered list.
 * - Single-ref models (IP-Adapter Face, PuLID, Style Transfer) accept only
 *   `image_url: string` — anything past index 0 is ignored.
 *
 * The conservative pattern from {@link generateCharacterRef} is to always
 * populate `image_url` with the first URL AND `image_urls` with the full array
 * for multi-ref-capable models. Single-ref models just get `image_url`.
 *
 * This module centralizes that decision so the call site doesn't need to
 * special-case each endpoint.
 */

interface ReferenceImageMapping {
    /** Single-image input field (always populated when refs > 0). */
    image_url?: string;
    /** Multi-image input field (only set when the model supports more than one ref). */
    image_urls?: string[];
}

/**
 * Build the FAL input fragment for the supplied reference image URLs.
 * @param modelDefinition registry entry for the target model. Used to look up
 * `maxReferenceImages` so we don't oversend to a model
 * that ignores extras.
 * @param referenceImages ordered URLs from the composer's reference picker.
 * Order is preserved (the badge index the user saw).
 * @returns object to spread into the FAL providerOptions (or direct REST input).
 * Empty object when there are no references — caller can spread it
 * unconditionally without checks.
 */
export const buildFalReferenceImageInput = (modelDefinition: ModelDefinition, referenceImages: ReadonlyArray<string> | undefined): ReferenceImageMapping => {
    if (!referenceImages || referenceImages.length === 0) {
        return {};
    }

    const cap = modelDefinition.maxReferenceImages ?? 0;

    if (cap <= 0) {
        // Model doesn't support reference images — drop silently rather than 400.
        // The composer gates by the same flag, so this branch is mostly defence
        // against a stale tool-call argument arriving after a model swap.
        return {};
    }

    const clamped = referenceImages.slice(0, cap);
    const primary = clamped[0];

    if (!primary) {
        return {};
    }

    const result: ReferenceImageMapping = { image_url: primary };

    if (cap > 1 && clamped.length > 1) {
        result.image_urls = [...clamped];
    }

    return result;
};
