import { describe, expect, it } from "vitest";

import { exceedsRawInputLimit } from "./host-input";

const SEND_LIMIT = 30_000;

describe("exceedsRawInputLimit", () => {
    it("allows a draft up to the raw limit, which is above the send limit", () => {
        expect(exceedsRawInputLimit("x".repeat(SEND_LIMIT * 4), SEND_LIMIT)).toBe(false);
        expect(exceedsRawInputLimit("x".repeat(SEND_LIMIT + 1), SEND_LIMIT)).toBe(false);
    });

    it("refuses a value one character past the raw limit", () => {
        expect(exceedsRawInputLimit("x".repeat(SEND_LIMIT * 4 + 1), SEND_LIMIT)).toBe(true);
    });
});
