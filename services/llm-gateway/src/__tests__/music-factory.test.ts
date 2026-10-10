import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "../lib/errors.js";
import { extractAudioPart, runFalMusicGeneration } from "../providers/music-factory.js";

const AUDIO_URL = "https://files.fal.ai/out.wav";
const MALFORMED_ERROR_RE = /malformed/i;
const FAILED_ERROR_RE = /failed/i;
const NO_AUDIO_URL_ERROR_RE = /no audio url/i;
const POLL_WINDOW_ERROR_RE = /poll window/i;

describe("extractAudioPart", () => {
    it("returns null with no audio fields", () => {
        expect(extractAudioPart({})).toBeNull();
    });

    it("reads { audio: { url, content_type, sample_rate } }", () => {
        expect(extractAudioPart({ audio: { content_type: "audio/wav", sample_rate: 48_000, url: AUDIO_URL } })).toEqual({
            contentType: "audio/wav",
            sampleRate: 48_000,
            url: AUDIO_URL,
        });
    });

    it("reads { audio_file: { url } }", () => {
        expect(extractAudioPart({ audio_file: { url: AUDIO_URL } })).toEqual({
            contentType: undefined,
            sampleRate: undefined,
            url: AUDIO_URL,
        });
    });

    it("accepts a bare string candidate", () => {
        expect(extractAudioPart({ audio_url: AUDIO_URL })).toEqual({ url: AUDIO_URL });
    });

    it("prefers audio over audio_file over audio_url", () => {
        expect(extractAudioPart({ audio: { url: "https://a/1" }, audio_file: { url: "https://a/2" }, audio_url: "https://a/3" })).toEqual({
            contentType: undefined,
            sampleRate: undefined,
            url: "https://a/1",
        });
    });
});

// ── runFalMusicGeneration: queue submit → poll → fetch bytes ──────────────────

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { headers: { "content-type": "application/json" }, status });

describe("runFalMusicGeneration", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("submits, polls past IN_PROGRESS, then downloads the audio bytes", async () => {
        const audioBytes = new Uint8Array([1, 2, 3, 4]);
        const fetchMock = vi
            .fn()
            // 1. submit
            .mockResolvedValueOnce(jsonResponse({ response_url: "https://q/result", status_url: "https://q/status" }))
            // 2. status poll #1 — still running
            .mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS" }))
            // 3. status poll #2 — completed
            .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
            // 4. result fetch
            .mockResolvedValueOnce(jsonResponse({ audio: { content_type: "audio/wav", sample_rate: 44_100, url: AUDIO_URL } }))
            // 5. audio byte download
            .mockResolvedValueOnce(new Response(audioBytes, { headers: { "content-type": "audio/wav" }, status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        const result = await runFalMusicGeneration("fal-ai/stable-audio-25", "key", { prompt: "lofi" }, { pollIntervalMs: 1 });

        expect(result.mimeType).toBe("audio/wav");
        expect(result.sampleRate).toBe(44_100);
        expect([...result.bytes]).toEqual([1, 2, 3, 4]);
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("throws PROVIDER_ERROR when submit fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })));

        await expect(runFalMusicGeneration("fal-ai/stable-audio-25", "key", {}, { pollIntervalMs: 1 })).rejects.toBeInstanceOf(GatewayError);
    });

    it("throws when submit response is missing status/response URLs", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ request_id: "abc" })));

        await expect(runFalMusicGeneration("fal-ai/stable-audio-25", "key", {}, { pollIntervalMs: 1 })).rejects.toThrow(MALFORMED_ERROR_RE);
    });

    it("throws when FAL reports the render FAILED", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ response_url: "https://q/result", status_url: "https://q/status" }))
            .mockResolvedValueOnce(jsonResponse({ status: "FAILED" }));

        vi.stubGlobal("fetch", fetchMock);

        await expect(runFalMusicGeneration("fal-ai/stable-audio-25", "key", {}, { pollIntervalMs: 1 })).rejects.toThrow(FAILED_ERROR_RE);
    });

    it("throws when the completed result has no audio URL", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ response_url: "https://q/result", status_url: "https://q/status" }))
            .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
            .mockResolvedValueOnce(jsonResponse({ seed: 42 }));

        vi.stubGlobal("fetch", fetchMock);

        await expect(runFalMusicGeneration("fal-ai/stable-audio-25", "key", {}, { pollIntervalMs: 1 })).rejects.toThrow(NO_AUDIO_URL_ERROR_RE);
    });

    it("times out when the poll window elapses without completion", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ response_url: "https://q/result", status_url: "https://q/status" }))
            // Fresh Response per poll — a reused one would 500 on the second
            // `.json()` ("Body is unusable") and mask the timeout path.
            .mockImplementation(async () => jsonResponse({ status: "IN_PROGRESS" }));

        vi.stubGlobal("fetch", fetchMock);

        await expect(runFalMusicGeneration("fal-ai/stable-audio-25", "key", {}, { maxPollMs: 5, pollIntervalMs: 1 })).rejects.toThrow(POLL_WINDOW_ERROR_RE);
    });
});
