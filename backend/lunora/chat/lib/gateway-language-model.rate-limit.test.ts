/**
 * The gateway sends a provider's rate limit as data (`rateLimit: { status, retryAt }`); the model
 * proxy attaches it to the error it throws, so a run can pause on it (`rate-limit-pause.ts`).
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { GatewayLanguageModel } from "./gateway-language-model";

const OPTIONS = { prompt: [] } as unknown as LanguageModelV3CallOptions;
const RETRY_AT = Date.now() + 42_000;

const modelAnswering = (response: Response) =>
    new GatewayLanguageModel({ gateway: async () => response, modelApiId: "m", modelId: "m", provider: "anthropic" });

describe("GatewayLanguageModel carries a provider rate limit", () => {
    it.each(["doGenerate", "doStream"] as const)("%s: from the error body, with the provider", async (method) => {
        const model = modelAnswering(
            Response.json(
                { error: { code: "PROVIDER_ERROR", fallbackReason: "infra", message: "slow down", rateLimit: { retryAt: RETRY_AT, status: 429 } } },
                { status: 502 },
            ),
        );

        await expect(model[method](OPTIONS)).rejects.toMatchObject({
            fallbackReason: "infra",
            rateLimit: { provider: "anthropic", retryAt: RETRY_AT, status: 429 },
        });
    });

    it("from an error event sent after the 200", async () => {
        const body = `data: ${JSON.stringify({ error: "slow down", fallbackReason: "infra", rateLimit: { retryAt: RETRY_AT, status: 429 }, type: "error" })}\n\n`;
        const { stream } = await modelAnswering(new Response(body, { status: 200 })).doStream(OPTIONS);

        await expect(stream.getReader().read()).rejects.toMatchObject({ rateLimit: { provider: "anthropic", retryAt: RETRY_AT, status: 429 } });
    });

    it("keeps a bare 429 with no retry time", async () => {
        const model = modelAnswering(Response.json({ error: { message: "slow down", rateLimit: { status: 429 } } }, { status: 502 }));
        const error = (await model.doGenerate(OPTIONS).catch((error_: unknown) => error_)) as { rateLimit?: unknown };

        expect(error.rateLimit).toEqual({ provider: "anthropic", status: 429 });
    });

    it("leaves the field off an error without one, and off a malformed one", async () => {
        for (const rateLimit of [undefined, "429", { status: "429" }, null]) {
            const model = modelAnswering(Response.json({ error: { message: "boom", ...(rateLimit !== undefined && { rateLimit }) } }, { status: 502 }));
            const error = await model.doGenerate(OPTIONS).catch((error_: unknown) => error_);

            expect(error).not.toHaveProperty("rateLimit");
        }
    });

    it("does not infer one from the message or the status alone", async () => {
        const model = modelAnswering(Response.json({ error: { message: "Rate limit exceeded (429)" } }, { status: 429 }));
        const error = await model.doGenerate(OPTIONS).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ statusCode: 429 });
        expect(error).not.toHaveProperty("rateLimit");
    });
});
