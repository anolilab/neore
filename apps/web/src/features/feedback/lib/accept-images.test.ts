import { describe, expect, it } from "vitest";

import { acceptFeedbackImages, FEEDBACK_IMAGE_PICK_MAX_BYTES } from "./accept-images";

const image = (type = "image/png", size = 1000) => {
    return { size, type };
};

describe(acceptFeedbackImages, () => {
    it("keeps still images and counts the rest as rejected", () => {
        const result = acceptFeedbackImages(0, [
            image(),
            image("image/svg+xml"),
            image("application/pdf"),
            image("image/jpeg", FEEDBACK_IMAGE_PICK_MAX_BYTES + 1),
        ]);

        expect(result.accepted).toStrictEqual([image()]);
        expect(result.rejected).toBe(3);
    });

    it("stops at four images in all", () => {
        const result = acceptFeedbackImages(3, [image(), image("image/webp"), image("image/gif")]);

        expect(result.accepted).toStrictEqual([image()]);
        expect(result.rejected).toBe(2);
    });
});
