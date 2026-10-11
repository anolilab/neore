import { describe, expect, it } from "vitest";

import { assertJsonWithinLimit, MAX_LENGTH } from "./validators";

const CONTENT_JSON_TOO_LARGE = /contentJson is larger than/;

describe("assertJsonWithinLimit", () => {
    it("accepts a missing value and any value within the cap", () => {
        expect(() => assertJsonWithinLimit(undefined, "contentJson")).not.toThrow();
        expect(() => assertJsonWithinLimit({ content: [], type: "doc" }, "contentJson")).not.toThrow();
    });

    it("refuses a value whose serialized size is over the cap", () => {
        const oversized = { text: "x".repeat(MAX_LENGTH.document) };

        expect(() => assertJsonWithinLimit(oversized, "contentJson")).toThrow(CONTENT_JSON_TOO_LARGE);
        expect(() => assertJsonWithinLimit(oversized, "contentJson")).toThrow(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    });
});
