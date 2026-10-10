import { describe, expect, it } from "vitest";

import { extractFalAudioUrl, resolveFalVideoUrl } from "./fal-media-parsing";

const AUDIO_URL = "https://files.fal.ai/out.mp3";
const VIDEO_URL = "https://files.fal.ai/out.mp4";

describe("extractFalAudioUrl", () => {
    it("returns null when no audio field is present", () => {
        expect(extractFalAudioUrl({})).toBeNull();
    });

    it("reads the canonical { audio: { url, content_type, sample_rate } } shape", () => {
        expect(extractFalAudioUrl({ audio: { content_type: "audio/mpeg", sample_rate: 44_100, url: AUDIO_URL } })).toEqual({
            contentType: "audio/mpeg",
            sampleRate: 44_100,
            url: AUDIO_URL,
        });
    });

    it("reads the { audio_file: { url } } shape (musicgen/cassetteai)", () => {
        expect(extractFalAudioUrl({ audio_file: { url: AUDIO_URL } })).toEqual({
            contentType: undefined,
            sampleRate: undefined,
            url: AUDIO_URL,
        });
    });

    it("accepts a bare string candidate (defensive fallback)", () => {
        expect(extractFalAudioUrl({ audio_url: AUDIO_URL })).toEqual({ url: AUDIO_URL });
    });

    it("prefers `audio` over `audio_file` over `audio_url`", () => {
        expect(
            extractFalAudioUrl({
                audio: { url: "https://a/1.mp3" },
                audio_file: { url: "https://a/2.mp3" },
                audio_url: "https://a/3.mp3",
            }),
        ).toEqual({ contentType: undefined, sampleRate: undefined, url: "https://a/1.mp3" });
    });

    it("skips an object candidate with no usable url and falls through", () => {
        expect(extractFalAudioUrl({ audio: { duration: 12 }, audio_file: { url: AUDIO_URL } })).toEqual({
            contentType: undefined,
            sampleRate: undefined,
            url: AUDIO_URL,
        });
    });

    it("ignores a non-string content_type / non-number sample_rate", () => {
        expect(extractFalAudioUrl({ audio: { content_type: 7, sample_rate: "44100", url: AUDIO_URL } })).toEqual({
            contentType: undefined,
            sampleRate: undefined,
            url: AUDIO_URL,
        });
    });
});

describe("resolveFalVideoUrl", () => {
    it("returns null when no video field is present", () => {
        expect(resolveFalVideoUrl({})).toBeNull();
    });

    it("reads the { video: { url, content_type } } shape", () => {
        expect(resolveFalVideoUrl({ video: { content_type: "video/webm", url: VIDEO_URL } })).toEqual({
            contentType: "video/webm",
            url: VIDEO_URL,
        });
    });

    it("defaults content type to video/mp4 when absent", () => {
        expect(resolveFalVideoUrl({ video: { url: VIDEO_URL } })).toEqual({
            contentType: "video/mp4",
            url: VIDEO_URL,
        });
    });

    it("falls back to videos[0] when `video` is missing", () => {
        expect(resolveFalVideoUrl({ videos: [{ content_type: "video/quicktime", url: VIDEO_URL }] })).toEqual({
            contentType: "video/quicktime",
            url: VIDEO_URL,
        });
    });

    it("accepts a string `output`", () => {
        expect(resolveFalVideoUrl({ output: VIDEO_URL })).toEqual({
            contentType: "video/mp4",
            url: VIDEO_URL,
        });
    });

    it("accepts an object `output` but does not read its content_type (matches pre-extraction behaviour)", () => {
        expect(resolveFalVideoUrl({ output: { content_type: "video/x-ignored", url: VIDEO_URL } })).toEqual({
            contentType: "video/mp4",
            url: VIDEO_URL,
        });
    });

    it("prefers `video` over `videos` over `output`", () => {
        expect(
            resolveFalVideoUrl({
                output: "https://v/3.mp4",
                video: { url: "https://v/1.mp4" },
                videos: [{ url: "https://v/2.mp4" }],
            }),
        ).toEqual({ contentType: "video/mp4", url: "https://v/1.mp4" });
    });
});
