import { FEEDBACK_IMAGE_TYPES, MAX_FEEDBACK_IMAGES } from "@neore/backend/feedback-limits";

/** A photo may be larger than the server's limit as picked: it is downscaled before upload. This caps what is read into memory. */
export const FEEDBACK_IMAGE_PICK_MAX_BYTES = 40 * 1024 * 1024;

export interface AcceptedImages<T> {
    accepted: T[];
    /** How many were left out: not a still image, too large to read, or past the image limit. */
    rejected: number;
}

/**
 * The images of `incoming` that may join the `held` ones: still images only, each small
 * enough to read, and no more than {@link MAX_FEEDBACK_IMAGES} in all.
 */
export const acceptFeedbackImages = <T extends { size: number; type: string }>(held: number, incoming: ReadonlyArray<T>): AcceptedImages<T> => {
    const usable = incoming.filter((file) => FEEDBACK_IMAGE_TYPES.includes(file.type) && file.size <= FEEDBACK_IMAGE_PICK_MAX_BYTES);
    const accepted = usable.slice(0, Math.max(MAX_FEEDBACK_IMAGES - held, 0));

    return { accepted, rejected: incoming.length - accepted.length };
};
