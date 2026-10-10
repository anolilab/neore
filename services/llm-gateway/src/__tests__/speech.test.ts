/**
 * `/internal/speech` — binding-only, registry speech models only, and every call
 * reported to the backend at a cost proportional to its characters.
 */
import { DEFAULT_SPEECH_MODEL, GATEWAY_SPEECH_MODELS } from "@neore/ai/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import { app } from "../index.js";
import { resolveSpeechVoice, speechCostMicrodollars } from "../routes/internal/speech.js";
import { bindingEnv, makeInternalRequest } from "./helpers/internal.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";

const { generateSpeech } = vi.hoisted(() => {
    return { generateSpeech: vi.fn() };
});

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), experimental_generateSpeech: generateSpeech };
});

const MODEL = GATEWAY_SPEECH_MODELS[DEFAULT_SPEECH_MODEL]!;

const env = (): AppEnv => ({ ...createMockEnv(), FAL_API_KEY: "platform-fal-key" }) as unknown as AppEnv;

const post = async (payload: Record<string, unknown>, ctx = createMockCtx()) => {
    const request = makeInternalRequest("POST", "/internal/speech", JSON.stringify(payload));

    return { ctx, response: await app.fetch(request, bindingEnv(env()), ctx) };
};

const reports: { billingMode?: string; costMicrodollars: number; promptTokens: number; userId: string }[] = [];

beforeEach(() => {
    generateSpeech.mockResolvedValue({ audio: { mediaType: "audio/mpeg", uint8Array: new Uint8Array([1, 2, 3]) } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/gateway/usage-report")) {
            reports.push(JSON.parse(String(init?.body)));
        }

        return Response.json({ ok: true });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    generateSpeech.mockReset();
    reports.length = 0;
});

describe("POST /internal/speech", () => {
    it("refuses a public request (not through the binding) with a 404", async () => {
        const response = await app.fetch(
            new Request("http://localhost/internal/speech", { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" }),
            env(),
            createMockCtx(),
        );

        expect(response.status).toBe(404);
        expect(generateSpeech).not.toHaveBeenCalled();
    });

    it("refuses a model that is not a priced registry speech model", async () => {
        const { response } = await post({ modelId: "openai/gpt-4o", requestId: "r1", text: "Hello", userId: "u1" });

        expect(response.status).toBe(400);
        expect(generateSpeech).not.toHaveBeenCalled();
    });

    it("returns the audio and reports a cost proportional to the characters", async () => {
        const text = "Hello there, this is a reply.";
        const { ctx, response } = await post({ modelId: DEFAULT_SPEECH_MODEL, requestId: "r2", text, userId: "u1" });

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("audio/mpeg");
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
        expect(response.headers.get("x-gateway-cost-microdollars")).toBe(String(speechCostMicrodollars(MODEL, text.length)));

        await ctx.flush();

        expect(reports).toEqual([
            expect.objectContaining({
                billingMode: "platform",
                costMicrodollars: speechCostMicrodollars(MODEL, text.length),
                promptTokens: text.length,
                userId: "u1",
            }),
        ]);
    });

    it("bills a call on the user's own key as byok", async () => {
        const { ctx } = await post({ modelId: DEFAULT_SPEECH_MODEL, providerApiKey: "user-fal-key", requestId: "r3", text: "Hi", userId: "u1" });

        await ctx.flush();

        expect(reports[0]?.billingMode).toBe("byok");
    });

    it("sends a preset voice in voice_setting and replaces an unknown one with the default", async () => {
        await post({ modelId: DEFAULT_SPEECH_MODEL, requestId: "r4", text: "Hi", userId: "u1", voice: "Calm_Woman" });
        await post({ modelId: DEFAULT_SPEECH_MODEL, requestId: "r5", text: "Hi", userId: "u1", voice: "Samantha" });

        expect(generateSpeech.mock.calls[0]?.[0]).toMatchObject({ providerOptions: { fal: { voice_setting: { voice_id: "Calm_Woman" } } } });
        expect(generateSpeech.mock.calls[1]?.[0]).toMatchObject({ providerOptions: { fal: { voice_setting: { voice_id: MODEL.defaultVoice } } } });
    });

    it("refuses text over the cap", async () => {
        const { response } = await post({ modelId: DEFAULT_SPEECH_MODEL, requestId: "r6", text: "x".repeat(5000), userId: "u1" });

        expect(response.status).toBe(400);
    });
});

describe("speech pricing and voices", () => {
    it("rounds the cost up and never charges nothing for text", () => {
        expect(speechCostMicrodollars({ costPerThousandCharsMicrodollars: 60_000 }, 1000)).toBe(60_000);
        expect(speechCostMicrodollars({ costPerThousandCharsMicrodollars: 60_000 }, 1)).toBe(60);
        expect(speechCostMicrodollars({ costPerThousandCharsMicrodollars: 7 }, 1)).toBe(1);
    });

    it("keeps a known preset, trims it, and falls back otherwise", () => {
        const model = { defaultVoice: "A", voices: ["A", "B"] };

        expect(resolveSpeechVoice(model, " B ")).toBe("B");
        expect(resolveSpeechVoice(model, "C")).toBe("A");
        expect(resolveSpeechVoice(model, undefined)).toBe("A");
    });
});
