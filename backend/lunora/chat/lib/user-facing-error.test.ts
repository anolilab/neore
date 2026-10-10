import { describe, expect, it } from "vitest";

import { StreamFailedError } from "./persist-stream";
import { toUserFacingError, USER_FACING_ERRORS } from "./user-facing-error";

// The exact texts the gateway proxy produced in local runs — each leaked verbatim
// into the failed assistant message before this mapping existed.
const GATEWAY_AUTH = "Gateway model proxy failed (502): Missing Authentication header";
const GATEWAY_NO_KEY = "Gateway model proxy failed (503): No API key for provider: openrouter";
const GATEWAY_BANNED =
    'Gateway model proxy failed (400): {"error":"BANNED_CONTENT","message":"Your message contains inappropriate content that cannot be sent."}';
const GATEWAY_LOCKED =
    'Gateway model proxy failed (500): {"details":"TypeError: This ReadableStream is currently locked to a reader, at verifyHmac (file:///x/index.js:1:1)"}';

describe(toUserFacingError, () => {
    it.each([
        [GATEWAY_AUTH, USER_FACING_ERRORS.authentication],
        [GATEWAY_NO_KEY, USER_FACING_ERRORS.authentication],
        [GATEWAY_BANNED, USER_FACING_ERRORS.contentBlocked],
        [GATEWAY_LOCKED, USER_FACING_ERRORS.unavailable],
        ["429 Too Many Requests", USER_FACING_ERRORS.rateLimit],
        ["This model's maximum context length is 8192 tokens", USER_FACING_ERRORS.contextExceeded],
        ["The operation was aborted due to timeout", USER_FACING_ERRORS.unavailable],
        ["AbortError: The user aborted a request.", USER_FACING_ERRORS.stopped],
        ["something nobody anticipated at https://internal.example/x", USER_FACING_ERRORS.generic],
    ])("maps %j", (raw, expected) => {
        expect(toUserFacingError(raw)).toBe(expected);
    });

    it("reads the cause chain the agent's StreamFailedError wraps", () => {
        expect(toUserFacingError(new StreamFailedError(new Error(GATEWAY_AUTH)))).toBe(USER_FACING_ERRORS.authentication);
    });

    it("never echoes the raw text back", () => {
        for (const raw of [GATEWAY_AUTH, GATEWAY_NO_KEY, GATEWAY_BANNED, GATEWAY_LOCKED]) {
            expect(Object.values(USER_FACING_ERRORS)).toContain(toUserFacingError(raw));
        }
    });

    it("blames the user's own endpoint for its failures, but not our content filter's verdict", () => {
        expect(toUserFacingError(GATEWAY_AUTH, { customEndpoint: true })).toBe(USER_FACING_ERRORS.customEndpoint);
        expect(toUserFacingError(GATEWAY_BANNED, { customEndpoint: true })).toBe(USER_FACING_ERRORS.contentBlocked);
    });

    it("is idempotent, so an already-mapped message survives a second pass", () => {
        for (const message of Object.values(USER_FACING_ERRORS)) {
            expect(toUserFacingError(message)).toBe(message);
        }
    });

    it("passes our own run-lifecycle reasons through", () => {
        expect(toUserFacingError("Restarting")).toBe("Restarting");
        expect(toUserFacingError("Context exceeded — retrying with compression")).toBe("Context exceeded — retrying with compression");
    });
});
