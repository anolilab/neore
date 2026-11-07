import { api } from "@neore/backend/api";
import { describe, expect, it, vi } from "vitest";

import type { VoiceClient } from "./voice-input";
import { appendTranscript, TRANSCRIBE_TIMEOUT_MS, transcribeClip, voiceErrorMessage } from "./voice-input";

const NEEDS_CONNECTION = /needs a connection/u;

describe(appendTranscript, () => {
    it.each([
        ["", " hello ", "hello"],
        ["Hi", "there", "Hi there"],
        ["Hi ", "there", "Hi there"],
        ["Hi\n", "there", "Hi\nthere"],
        ["Keep me", " ".repeat(3), "Keep me"],
    ])("adds %j + %j as %j", (draft, text, expected) => {
        expect(appendTranscript(draft, text)).toBe(expected);
    });
});

describe(transcribeClip, () => {
    it("sends the clip and returns the text", async () => {
        const action = vi.fn(async () => {
            return { text: "hello" };
        });

        await expect(transcribeClip({ action } as unknown as VoiceClient, { audio: "QUJD", durationMs: 1200 })).resolves.toBe("hello");
        expect(action).toHaveBeenCalledWith(api.voice.transcription.transcribeClip, { audio: "QUJD", durationMs: 1200 }, { signal: expect.any(AbortSignal) });
    });

    it("aborts a call that stalls past the deadline", async () => {
        vi.useFakeTimers();

        const action = vi.fn(
            async (_function: unknown, _args: unknown, options: { signal: AbortSignal }) =>
                await new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => {
                        reject(new Error("aborted"));
                    });
                }),
        );
        const pending = transcribeClip({ action } as unknown as VoiceClient, { audio: "QUJD", durationMs: 1200 });
        const settled = expect(pending).rejects.toThrow("aborted");

        await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS);
        await settled;
        vi.useRealTimers();
    });
});

describe(voiceErrorMessage, () => {
    it("shows the server's own words for a guest or a spent allowance, and a plain message for anything else", () => {
        const refusal = Object.assign(new Error("Create an account to use voice input."), { code: "FORBIDDEN" });
        const allowanceSpent = Object.assign(new Error("You've used today's voice input allowance."), { data: { code: "TOO_MANY_REQUESTS" } });
        const failure = Object.assign(new Error("Transcription gateway error: 502 upstream"), { code: "INTERNAL_SERVER_ERROR" });

        expect(voiceErrorMessage(refusal)).toBe("Create an account to use voice input.");
        expect(voiceErrorMessage(allowanceSpent)).toBe("You've used today's voice input allowance.");
        expect(voiceErrorMessage(failure)).toBe("The recording could not be turned into text. Try again, or type your message.");
        expect(voiceErrorMessage(new TypeError("Network request failed"))).toMatch(NEEDS_CONNECTION);
    });
});
