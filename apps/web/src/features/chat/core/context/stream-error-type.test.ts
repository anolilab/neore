import { describe, expect, it, vi } from "vitest";

import { RateLimitError } from "@/lib/errors";

import { gatewayError } from "./chat-gateway";
import { streamErrorType } from "./stream-error-type";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});

describe(streamErrorType, () => {
    it("names a gateway failure by its kind, never by a message that can hold the person's text", () => {
        const failure = new Error("model refused: my private prompt text");

        expect(streamErrorType(failure)).toBe("Error");
        expect(streamErrorType(new TypeError("Failed to fetch"))).toBe("TypeError");
        expect(streamErrorType("thrown string")).toBe("unknown");
    });

    it("names a gateway failure by the gateway's code, else its HTTP status, never by a message in the code field", () => {
        expect(streamErrorType(gatewayError(400, { error: "banned_words", message: "my private prompt text" }))).toBe("banned_words");
        expect(streamErrorType(gatewayError(403, { error: { code: "AUTH_REQUIRED", message: "sign in" } }))).toBe("AUTH_REQUIRED");
        expect(streamErrorType(gatewayError(500, { error: "my private prompt text" }))).toBe("HTTP_500");
        expect(streamErrorType(gatewayError(502, {}))).toBe("HTTP_502");
    });

    it("names an app error by its code", () => {
        expect(streamErrorType(new RateLimitError("slow down: my private prompt text", 1000))).toBe(new RateLimitError("x", 1000).code);
    });
});
