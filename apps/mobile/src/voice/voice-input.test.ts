import { api } from "@neore/backend/api";
import { describe, expect, it, vi } from "vitest";

import type { VoiceClient } from "./voice-input";
import { appendTranscript, transcribeClip, voiceErrorMessage } from "./voice-input";

describe(appendTranscript, () => {
    it.each([
        ["", " hello ", "hello"],
        ["Hi", "there", "Hi there"],
        ["Hi ", "there", "Hi there"],
        ["Hi\n", "there", "Hi\nthere"],
        ["Keep me", "   ", "Keep me"],
    ])("adds %j + %j as %j", (draft, text, expected) => {
        expect(appendTranscript(draft, text)).toBe(expected);
    });
});

describe(transcribeClip, () => {
    it("sends the clip and returns the text", async () => {
        const action = vi.fn(async () => ({ text: "hello" }));

        await expect(transcribeClip({ action } as unknown as VoiceClient, { audio: "QUJD", durationMs: 1200 })).resolves.toBe("hello");
        expect(action).toHaveBeenCalledWith(api.voice.transcription.transcribeClip, { audio: "QUJD", durationMs: 1200 });
    });
});

describe(voiceErrorMessage, () => {
    it("shows the server's own words for a guest or a spent allowance, and a plain message for anything else", () => {
        const refusal = Object.assign(new Error("Create an account to use voice input."), { code: "FORBIDDEN" });
        const failure = Object.assign(new Error("Transcription gateway error: 502 upstream"), { code: "INTERNAL_SERVER_ERROR" });

        expect(voiceErrorMessage(refusal)).toBe("Create an account to use voice input.");
        expect(voiceErrorMessage(failure)).toBe("The recording could not be turned into text. Try again, or type your message.");
        expect(voiceErrorMessage(new TypeError("Network request failed"))).toMatch(/needs a connection/u);
    });
});
