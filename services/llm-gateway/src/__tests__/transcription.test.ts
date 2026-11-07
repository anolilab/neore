/**
 * `/internal/transcription` — binding-only, text back and nothing kept, and
 * every call reported at a cost per second of audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import { app } from "../index.js";
import { transcriptionCostMicrodollars } from "../routes/internal/transcription.js";
import { bindingEnv, makeInternalRequest } from "./helpers/internal.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";

const { transcribe } = vi.hoisted(() => {
    return { transcribe: vi.fn() };
});

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), experimental_transcribe: transcribe };
});

const env = (): AppEnv => ({ ...createMockEnv(), OPENAI_API_KEY: "platform-key" }) as unknown as AppEnv;

const post = async (payload: Record<string, unknown>, ctx = createMockCtx()) => {
    const request = makeInternalRequest("POST", "/internal/transcription", JSON.stringify(payload));

    return { ctx, response: await app.fetch(request, bindingEnv(env()), ctx) };
};

const CLIP = { audio: "AAAA", durationSeconds: 3, requestId: "r1", userId: "u1" };

const reports: { billingMode?: string; costMicrodollars: number; promptTokens: number; userId: string }[] = [];

beforeEach(() => {
    transcribe.mockResolvedValue({ durationInSeconds: 4.2, text: "hello there" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/gateway/usage-report")) {
            reports.push(JSON.parse(String(init?.body)));
        }

        return Response.json({ ok: true });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    transcribe.mockReset();
    reports.length = 0;
});

describe("POST /internal/transcription", () => {
    it("refuses a public request (not through the binding) with a 404", async () => {
        const response = await app.fetch(
            new Request("http://localhost/internal/transcription", { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" }),
            env(),
            createMockCtx(),
        );

        expect(response.status).toBe(404);
        expect(transcribe).not.toHaveBeenCalled();
    });

    it("returns the text and reports the provider's duration, not the client's", async () => {
        const { ctx, response } = await post(CLIP);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ costMicrodollars: transcriptionCostMicrodollars(4.2), text: "hello there" });

        await ctx.flush();

        expect(reports).toEqual([expect.objectContaining({ billingMode: "platform", costMicrodollars: transcriptionCostMicrodollars(4.2), promptTokens: 5 })]);
    });

    it("falls back to the client's duration when the provider reports none, and bills the user's own key as byok", async () => {
        transcribe.mockResolvedValue({ text: "hi" });
        const { ctx } = await post({ ...CLIP, providerApiKey: "user-key" });

        await ctx.flush();

        expect(reports[0]).toMatchObject({ billingMode: "byok", costMicrodollars: transcriptionCostMicrodollars(3) });
    });

    it("answers a provider failure with 502", async () => {
        transcribe.mockRejectedValue(new Error("boom"));
        const { response } = await post(CLIP);

        expect(response.status).toBe(502);
    });

    it("refuses a request without audio", async () => {
        const { response } = await post({ ...CLIP, audio: "" });

        expect(response.status).toBe(400);
        expect(transcribe).not.toHaveBeenCalled();
    });
});
