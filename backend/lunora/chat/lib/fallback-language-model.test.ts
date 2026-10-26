import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { FallbackLanguageModel, isInfraFailure } from "./fallback-language-model";

const OPTIONS = { prompt: [] } as unknown as LanguageModelV3CallOptions;

/** A gateway error as `GatewayLanguageModel` throws it. */
const gatewayError = (fallbackReason: string | undefined) => Object.assign(new Error("Gateway model proxy failed (502)"), { fallbackReason, statusCode: 502 });

const fakeModel = (id: string, failure?: Error) => {
    const doGenerate = vi.fn(async () => {
        if (failure) throw failure;

        return { content: [{ text: id, type: "text" }] };
    });
    const doStream = vi.fn(async () => {
        if (failure) throw failure;

        return { stream: new ReadableStream() };
    });

    return { doGenerate, doStream, modelId: id, provider: "gateway/test", specificationVersion: "v3", supportedUrls: {} } as unknown as LanguageModelV3 & {
        doGenerate: ReturnType<typeof vi.fn>;
        doStream: ReturnType<typeof vi.fn>;
    };
};

describe("FallbackLanguageModel", () => {
    describe.each(["doGenerate", "doStream"] as const)("%s", (method) => {
        it("retries once on the backup after an infra failure", async () => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup");
            const result = await new FallbackLanguageModel(primary, backup)[method](OPTIONS);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).toHaveBeenCalledTimes(1);
            expect(result).toBeDefined();
        });

        it.each(["content_policy", "context_overflow", undefined])("does not retry a %s failure", async (reason) => {
            const error = gatewayError(reason);
            const primary = fakeModel("primary", error);
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(primary, backup)[method](OPTIONS)).rejects.toBe(error);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("does not retry an error that is not from the gateway", async () => {
            const primary = fakeModel("primary", new Error("boom"));
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(primary, backup)[method](OPTIONS)).rejects.toThrow("boom");

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("does not retry a run the user stopped", async () => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup");
            const stopped = AbortSignal.abort();

            await expect(new FallbackLanguageModel(primary, backup)[method]({ ...OPTIONS, abortSignal: stopped })).rejects.toThrow();

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("tries the backup once only: its failure surfaces", async () => {
            const backupError = gatewayError("infra");
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup", backupError);

            await expect(new FallbackLanguageModel(primary, backup)[method](OPTIONS)).rejects.toBe(backupError);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).toHaveBeenCalledTimes(1);
        });

        it("leaves a healthy primary alone", async () => {
            const primary = fakeModel("primary");
            const backup = fakeModel("backup");

            await new FallbackLanguageModel(primary, backup)[method](OPTIONS);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).not.toHaveBeenCalled();
        });
    });

    it("presents itself as the primary model", () => {
        const primary = fakeModel("primary");
        const model = new FallbackLanguageModel(primary, fakeModel("backup"));

        expect(model.modelId).toBe("primary");
        expect(model.provider).toBe("gateway/test");
        expect(model.supportedUrls).toBe(primary.supportedUrls);
    });
});

describe("isInfraFailure", () => {
    it("is true only for the gateway's infra classification", () => {
        expect(isInfraFailure(gatewayError("infra"))).toBe(true);
        expect(isInfraFailure(gatewayError("content_policy"))).toBe(false);
        expect(isInfraFailure(gatewayError(undefined))).toBe(false);
        expect(isInfraFailure("infra")).toBe(false);
        expect(isInfraFailure(null)).toBe(false);
    });
});
