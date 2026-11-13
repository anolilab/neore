import { describe, expect, it } from "vitest";

import { RateLimitError } from "@/lib/errors";

import { streamErrorType } from "./stream-error-type";

describe(streamErrorType, () => {
    it("names a gateway failure by its kind, never by a message that can hold the person's text", () => {
        const failure = new Error("model refused: my private prompt text");

        expect(streamErrorType(failure)).toBe("Error");
        expect(streamErrorType(new TypeError("Failed to fetch"))).toBe("TypeError");
        expect(streamErrorType("thrown string")).toBe("unknown");
    });

    it("names an app error by its code", () => {
        expect(streamErrorType(new RateLimitError("slow down: my private prompt text", 1000))).toBe(new RateLimitError("x", 1000).code);
    });
});
