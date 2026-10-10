import { describe, expect, it } from "vitest";

import { assertJsonWithinLimit, MAX_LENGTH } from "./validators";

describe("assertJsonWithinLimit", () => {
    it("accepts a missing value and any value within the cap", () => {
        expect(() => assertJsonWithinLimit(undefined, "contentJson")).not.toThrow();
        expect(() => assertJsonWithinLimit({ type: "doc", content: [] }, "contentJson")).not.toThrow();
    });

    it("refuses a value whose serialized size is over the cap", () => {
        const oversized = { text: "x".repeat(MAX_LENGTH.document) };

        expect(() => assertJsonWithinLimit(oversized, "contentJson")).toThrow(/contentJson is larger than/);
        expect(() => assertJsonWithinLimit(oversized, "contentJson")).toThrow(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    });
});
