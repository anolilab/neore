import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { GatewayLanguageModel } from "./gateway-language-model";

const OPTIONS = { prompt: [] } as unknown as LanguageModelV3CallOptions;

const modelAnswering = (response: Response) =>
    new GatewayLanguageModel({ gateway: async () => response, modelApiId: "m", modelId: "m", provider: "openrouter" });

describe("GatewayLanguageModel errors", () => {
    it.each(["doGenerate", "doStream"] as const)("%s carries the gateway's fallback reason and status", async (method) => {
        const model = modelAnswering(Response.json({ error: { code: "PROVIDER_ERROR", fallbackReason: "infra", message: "upstream down" } }, { status: 502 }));

        await expect(model[method](OPTIONS)).rejects.toMatchObject({ fallbackReason: "infra", statusCode: 502 });
    });

    it("doStream carries the fallback reason of an error event sent after the 200", async () => {
        const body = `data: ${JSON.stringify({ error: "upstream reset", fallbackReason: "infra", type: "error" })}\n\n`;
        const { stream } = await modelAnswering(new Response(body, { status: 200 })).doStream(OPTIONS);

        await expect(stream.getReader().read()).rejects.toMatchObject({ fallbackReason: "infra", message: "upstream reset" });
    });

    it("leaves the reason off an error the gateway did not classify", async () => {
        const model = modelAnswering(Response.json({ error: { code: "MODEL_BLOCKED", message: "blocked" } }, { status: 403 }));
        const error = await model.doGenerate(OPTIONS).catch((error_: unknown) => error_);

        expect(error).toMatchObject({ statusCode: 403 });
        expect(error).not.toHaveProperty("fallbackReason");
    });

    it("ignores a reason that is not a string", async () => {
        const model = modelAnswering(Response.json({ error: { fallbackReason: 7, message: "odd" } }, { status: 502 }));
        const error = await model.doGenerate(OPTIONS).catch((error_: unknown) => error_);

        expect(error).not.toHaveProperty("fallbackReason");
    });
});
