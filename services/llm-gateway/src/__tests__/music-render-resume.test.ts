/**
 * A render that failed while polling after its FAL submit is re-queued with the
 * submit's URLs, so the next delivery polls instead of submitting the job again.
 * A submit that never returned, or a failed re-send, must not be re-queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import { GatewayError } from "../lib/errors.js";
import { MUSIC_RENDER_MAX_RESUMES, runMusicRender } from "../routes/v1/music-render.js";
import type { MusicRenderMessage } from "../routes/v1/music-types.js";
import { MUSIC_RENDER_MESSAGE_VERSION } from "../routes/v1/music-types.js";

const { runFalMusicGeneration } = vi.hoisted(() => {
    return { runFalMusicGeneration: vi.fn() };
});

vi.mock("../providers/music-factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../providers/music-factory.js")>()),
        runFalMusicGeneration,
    };
});

const URLS = { responseUrl: "https://q/result", statusUrl: "https://q/status" };

const message = (overrides: Partial<MusicRenderMessage> = {}): MusicRenderMessage =>
    ({
        _version: MUSIC_RENDER_MESSAGE_VERSION,
        apiKeyId: undefined,
        body: { model: "stable-audio-25", prompt: "lofi" },
        enqueuedAt: Date.now(),
        isByok: false,
        jobId: "job-1",
        modelInfo: { costPerMusicGenerationMicrodollars: 0, modelApiId: "fal-ai/stable-audio-25", provider: "fal" },
        orgId: undefined,
        origin: "https://gateway.test",
        parentTraceparent: undefined,
        requestId: "req-1",
        userId: "user-1",
        ...overrides,
    }) as MusicRenderMessage;

const makeEnv = (send: ReturnType<typeof vi.fn>) => {
    const kv = new Map<string, string>([["music_render_secret:job-1", "provider-key"]]);

    return {
        CACHE_KV: { delete: async () => undefined, get: async (key: string) => kv.get(key) ?? null },
        MUSIC_BUCKET: { put: async () => undefined },
        MUSIC_RENDER_QUEUE: { send },
        RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
        USAGE_DB: {
            prepare: () => {
                return {
                    bind: () => {
                        return {
                            run: async () => {
                                return {};
                            },
                        };
                    },
                };
            },
        },
    } as unknown as AppEnv;
};

describe("runMusicRender resume", () => {
    beforeEach(() => {
        runFalMusicGeneration.mockReset();
    });

    it("re-queues a render whose poll failed transiently after submit, with the submit's URLs", async () => {
        runFalMusicGeneration.mockImplementation(async (_endpoint, _key, _inputs, options) => {
            options.onSubmitted(URLS);

            throw new GatewayError("PROVIDER_ERROR", "FAL status poll failed (503)", { statusCode: 503 });
        });

        const send = vi.fn(async (_message: MusicRenderMessage) => undefined);
        const outcome = await runMusicRender(message(), makeEnv(send));

        expect(outcome).toEqual({ kind: "requeued" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0]).toMatchObject({ jobId: "job-1", resume: { ...URLS, resumes: 1 } });
    });

    it("resumes from the URLs it was given and does not submit again", async () => {
        runFalMusicGeneration.mockRejectedValue(new GatewayError("PROVIDER_ERROR", "FAL status poll failed (503)", { statusCode: 503 }));

        const send = vi.fn(async (_message: MusicRenderMessage) => undefined);

        await runMusicRender(message({ resume: { ...URLS, resumes: 2 } }), makeEnv(send));

        const options = (runFalMusicGeneration.mock.calls[0] as unknown[])[3];

        expect(options).toMatchObject({ resume: URLS });
        expect(send.mock.calls[0]?.[0]).toMatchObject({ resume: { ...URLS, resumes: 3 } });
    });

    it("fails the render, rather than re-queueing it, once the resume cap is reached", async () => {
        runFalMusicGeneration.mockRejectedValue(new GatewayError("PROVIDER_ERROR", "FAL status poll failed (503)", { statusCode: 503 }));

        const send = vi.fn(async (_message: MusicRenderMessage) => undefined);
        const outcome = await runMusicRender(message({ resume: { ...URLS, resumes: MUSIC_RENDER_MAX_RESUMES } }), makeEnv(send));

        expect(send).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ kind: "failed", retryable: false });
    });

    it("fails the render when the re-send itself fails, rather than retrying it and submitting again", async () => {
        runFalMusicGeneration.mockImplementation(async (_endpoint, _key, _inputs, options) => {
            options.onSubmitted(URLS);

            throw new GatewayError("PROVIDER_ERROR", "FAL status poll failed (503)", { statusCode: 503 });
        });

        const send = vi.fn(async (_message: MusicRenderMessage) => {
            throw new Error("queue unavailable");
        });
        const outcome = await runMusicRender(message(), makeEnv(send));

        expect(send).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ kind: "failed", retryable: false });
    });

    it("does not re-queue a render that failed before the submit returned a queue URL", async () => {
        runFalMusicGeneration.mockRejectedValue(new GatewayError("PROVIDER_ERROR", "FAL submit failed (503)", { statusCode: 503 }));

        const send = vi.fn(async (_message: MusicRenderMessage) => undefined);
        const outcome = await runMusicRender(message(), makeEnv(send));

        expect(send).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ kind: "failed", retryable: false });
    });
});
