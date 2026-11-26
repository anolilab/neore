import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { type FallbackBackup, FallbackLanguageModel, isInfraFailure } from "./fallback-language-model";

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

        return {
            stream: new ReadableStream({
                start(controller) {
                    controller.close();
                },
            }),
        };
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
            const result = await new FallbackLanguageModel(primary, [{ model: backup }])[method](OPTIONS);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).toHaveBeenCalledTimes(1);
            expect(result).toBeDefined();
        });

        it.each(["content_policy", "context_overflow", undefined])("does not retry a %s failure", async (reason) => {
            const error = gatewayError(reason);
            const primary = fakeModel("primary", error);
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(primary, [{ model: backup }])[method](OPTIONS)).rejects.toBe(error);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("does not retry an error that is not from the gateway", async () => {
            const primary = fakeModel("primary", new Error("boom"));
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(primary, [{ model: backup }])[method](OPTIONS)).rejects.toThrow("boom");

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("does not retry a run the user stopped", async () => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup");
            const stopped = AbortSignal.abort();

            await expect(new FallbackLanguageModel(primary, [{ model: backup }])[method]({ ...OPTIONS, abortSignal: stopped })).rejects.toThrow();

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("tries the backup once only: its failure surfaces", async () => {
            const backupError = gatewayError("infra");
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup", backupError);

            await expect(new FallbackLanguageModel(primary, [{ model: backup }])[method](OPTIONS)).rejects.toBe(backupError);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).toHaveBeenCalledTimes(1);
        });

        it("leaves a healthy primary alone", async () => {
            const primary = fakeModel("primary");
            const backup = fakeModel("backup");

            await new FallbackLanguageModel(primary, [{ model: backup }])[method](OPTIONS);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).not.toHaveBeenCalled();
        });
    });

    it("retries a stream that errors before its first content part, and reports the backup as the model", async () => {
        const streamFailure = gatewayError("infra");
        const primary = fakeModel("primary");

        primary.doStream.mockResolvedValue({
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.error(streamFailure);
                },
            }),
        });

        const backup = fakeModel("backup");
        const model = new FallbackLanguageModel(primary, [{ model: backup }]);

        await model.doStream(OPTIONS);

        expect(backup.doStream).toHaveBeenCalledTimes(1);
        expect(model.modelId).toBe("backup");
    });

    it("still falls back when the stream fails after text-start but before any text", async () => {
        const primary = fakeModel("primary");

        primary.doStream.mockResolvedValue({
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ id: "1", type: "text-start" });
                    controller.enqueue({ delta: "", id: "1", type: "text-delta" });
                    controller.error(gatewayError("infra"));
                },
            }),
        });

        const backup = fakeModel("backup");

        await new FallbackLanguageModel(primary, [{ model: backup }]).doStream(OPTIONS);

        expect(backup.doStream).toHaveBeenCalledTimes(1);
    });

    it("cancels the abandoned primary stream before the backup starts", async () => {
        const order: string[] = [];
        const primary = fakeModel("primary");

        primary.doStream.mockResolvedValue({
            stream: {
                getReader: () => {
                    return {
                        cancel: async () => {
                            order.push("cancel");
                        },
                        read: async () => {
                            throw gatewayError("infra");
                        },
                    };
                },
            },
        });

        const backup = fakeModel("backup");

        backup.doStream.mockImplementation(async () => {
            order.push("backup");

            return { stream: new ReadableStream({ start: (controller) => controller.close() }) };
        });

        await new FallbackLanguageModel(primary, [{ model: backup }]).doStream(OPTIONS);

        expect(order).toEqual(["cancel", "backup"]);
    });

    it("does not replay a stream that fails after content was handed on", async () => {
        const primary = fakeModel("primary");

        primary.doStream.mockResolvedValue({
            stream: new ReadableStream({
                pull(controller) {
                    controller.enqueue({ delta: "hi", id: "1", type: "text-delta" });
                },
            }),
        });

        const backup = fakeModel("backup");
        const result = await new FallbackLanguageModel(primary, [{ model: backup }]).doStream(OPTIONS);
        const reader = result.stream.getReader();

        const first = await reader.read();

        expect(first.value).toMatchObject({ type: "text-delta" });
        expect(backup.doStream).not.toHaveBeenCalled();
    });

    it("does not send a call carrying tools to a backup that cannot call them", async () => {
        const error = gatewayError("infra");
        const primary = fakeModel("primary", error);
        const backup = fakeModel("backup");
        const model = new FallbackLanguageModel(primary, [{ model: backup, supportsTools: false }]);

        await expect(model.doGenerate({ ...OPTIONS, tools: [{ inputSchema: {}, name: "t", type: "function" }] })).rejects.toBe(error);
        expect(backup.doGenerate).not.toHaveBeenCalled();

        await model.doGenerate(OPTIONS);
        expect(backup.doGenerate).toHaveBeenCalledTimes(1);
    });

    describe("provider options on the backup", () => {
        const reasoningOptions = { openai: { reasoningEffort: "high", user: "u1" }, openrouter: { reasoning: { effort: "high" } } };
        const withOptions = { ...OPTIONS, providerOptions: reasoningOptions } as unknown as LanguageModelV3CallOptions;

        const backupOptions = async (traits: Omit<FallbackBackup, "model">) => {
            const backup = fakeModel("backup");

            await new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: backup, ...traits }]).doGenerate(withOptions);

            return (backup.doGenerate.mock.calls[0]![0] as LanguageModelV3CallOptions).providerOptions;
        };

        it("sends a non-reasoning backup no reasoning option and none of another provider's", async () => {
            expect(await backupOptions({ providerKey: "openai", supportsReasoning: false })).toEqual({ openai: { user: "u1" } });
        });

        it("drops the options altogether when nothing is left for the backup's provider", async () => {
            expect(await backupOptions({ providerKey: "google", supportsReasoning: true })).toBeUndefined();
        });

        it("keeps reasoning options for a backup that supports them on the same provider", async () => {
            expect(await backupOptions({ providerKey: "openai", supportsReasoning: true })).toEqual({
                openai: { reasoningEffort: "high", user: "u1" },
            });
        });

        it("leaves the primary's own call untouched", async () => {
            const primary = fakeModel("primary");

            await new FallbackLanguageModel(primary, [{ model: fakeModel("backup"), providerKey: "google" }]).doGenerate(withOptions);

            expect((primary.doGenerate.mock.calls[0]![0] as LanguageModelV3CallOptions).providerOptions).toBe(reasoningOptions);
        });
    });

    describe("once it has switched", () => {
        it.each(["doGenerate", "doStream"] as const)("%s: later steps go straight to the backup, not through the failing primary", async (method) => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const backup = fakeModel("backup");
            const model = new FallbackLanguageModel(primary, [{ model: backup }]);

            await model[method](OPTIONS);
            await model[method](OPTIONS);
            await model[method](OPTIONS);

            expect(primary[method]).toHaveBeenCalledTimes(1);
            expect(backup[method]).toHaveBeenCalledTimes(3);
            expect(model.modelId).toBe("backup");
        });

        it("still tries the primary for a step the backup could not take", async () => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const model = new FallbackLanguageModel(primary, [{ model: fakeModel("backup"), supportsImages: false }]);
            const image = {
                ...OPTIONS,
                prompt: [{ content: [{ data: "x", mediaType: "image/png", type: "file" }], role: "user" }],
            } as unknown as LanguageModelV3CallOptions;

            await model.doGenerate(OPTIONS);
            await expect(model.doGenerate(image)).rejects.toThrow();

            expect(primary.doGenerate).toHaveBeenCalledTimes(2);
        });
    });

    describe("a prompt sized for a larger primary", () => {
        // ~150k tokens: inside a 1M primary window, past the backup's 128k.
        const huge = {
            ...OPTIONS,
            prompt: [{ content: [{ text: "y".repeat(600_000), type: "text" }], role: "user" }],
        } as unknown as LanguageModelV3CallOptions;

        it.each(["doGenerate", "doStream"] as const)("%s: keeps the primary's error when the prompt cannot fit the backup's window", async (method) => {
            const error = gatewayError("infra");
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(fakeModel("primary", error), [{ model: backup }])[method](huge)).rejects.toBe(error);

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("falls back for a prompt that fits", async () => {
            const backup = fakeModel("backup");

            await new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: backup }]).doGenerate(OPTIONS);

            expect(backup.doGenerate).toHaveBeenCalledTimes(1);
        });
    });

    describe("a call the backup cannot take", () => {
        const withAttachment = (part: object) => ({ ...OPTIONS, prompt: [{ content: [part], role: "user" }] }) as unknown as LanguageModelV3CallOptions;
        const image = withAttachment({ data: "x", mediaType: "image/png", type: "file" });
        const pdf = withAttachment({ data: "x", mediaType: "application/pdf", type: "file" });

        it.each(["doGenerate", "doStream"] as const)("%s: keeps the primary's error when the call has an image and the backup cannot see", async (method) => {
            const error = gatewayError("infra");
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(fakeModel("primary", error), [{ model: backup, supportsImages: false }])[method](image)).rejects.toBe(error);

            expect(backup[method]).not.toHaveBeenCalled();
        });

        it("keeps the primary's error when the call has a document and the backup cannot read it", async () => {
            const error = gatewayError("infra");
            const backup = fakeModel("backup");

            await expect(new FallbackLanguageModel(fakeModel("primary", error), [{ model: backup, supportsFiles: false }]).doGenerate(pdf)).rejects.toBe(error);

            expect(backup.doGenerate).not.toHaveBeenCalled();
        });

        it("still falls back for the same attachments when the backup supports them", async () => {
            const backup = fakeModel("backup");

            await new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: backup }]).doGenerate(image);

            expect(backup.doGenerate).toHaveBeenCalledTimes(1);
        });

        it("backupsServing is the rule prompt sizing asks too", () => {
            const model = new FallbackLanguageModel(fakeModel("primary"), [
                { model: fakeModel("blind"), supportsImages: false },
                { model: fakeModel("sighted") },
            ]);

            expect(model.backupsServing({ hasTools: false, messages: [{ content: [{ image: "x", type: "image" }], role: "user" }] })).toEqual(["sighted"]);
            expect(model.backupsServing({ hasTools: false, messages: [{ content: "hi", role: "user" }] })).toEqual(["blind", "sighted"]);
        });
    });

    describe("several backups", () => {
        it.each(["doGenerate", "doStream"] as const)("%s: tries them in order until one answers", async (method) => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const first = fakeModel("first", gatewayError("infra"));
            const second = fakeModel("second");
            const third = fakeModel("third");
            const model = new FallbackLanguageModel(primary, [{ model: first }, { model: second }, { model: third }]);

            await model[method](OPTIONS);

            expect(first[method]).toHaveBeenCalledTimes(1);
            expect(second[method]).toHaveBeenCalledTimes(1);
            expect(third[method]).not.toHaveBeenCalled();
            expect(model.modelId).toBe("second");
        });

        it.each(["doGenerate", "doStream"] as const)("%s: surfaces the last backup's error when every one fails", async (method) => {
            const lastError = gatewayError("infra");
            const model = new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [
                { model: fakeModel("first", gatewayError("infra")) },
                { model: fakeModel("second", lastError) },
            ]);

            await expect(model[method](OPTIONS)).rejects.toBe(lastError);
        });

        it("skips a backup that cannot take the call and goes on to the next", async () => {
            const blind = fakeModel("blind");
            const sighted = fakeModel("sighted");
            const image = {
                ...OPTIONS,
                prompt: [{ content: [{ data: "x", mediaType: "image/png", type: "file" }], role: "user" }],
            } as unknown as LanguageModelV3CallOptions;

            await new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [
                { model: blind, supportsImages: false },
                { model: sighted },
            ]).doGenerate(image);

            expect(blind.doGenerate).not.toHaveBeenCalled();
            expect(sighted.doGenerate).toHaveBeenCalledTimes(1);
        });

        it("does not move on after a failure that is not the gateway's infra classification", async () => {
            const error = gatewayError("content_policy");
            const second = fakeModel("second");
            const model = new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: fakeModel("first", error) }, { model: second }]);

            await expect(model.doGenerate(OPTIONS)).rejects.toBe(error);
            expect(second.doGenerate).not.toHaveBeenCalled();
        });

        it("stops hopping once the run is stopped", async () => {
            const stopping = new AbortController();
            const first = fakeModel("first");
            const second = fakeModel("second");

            first.doGenerate.mockImplementation(async () => {
                stopping.abort();

                throw gatewayError("infra");
            });

            const model = new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: first }, { model: second }]);

            await expect(model.doGenerate({ ...OPTIONS, abortSignal: stopping.signal })).rejects.toThrow();
            expect(second.doGenerate).not.toHaveBeenCalled();
        });

        it("starts later steps on the backup that answered", async () => {
            const primary = fakeModel("primary", gatewayError("infra"));
            const first = fakeModel("first", gatewayError("infra"));
            const second = fakeModel("second");
            const model = new FallbackLanguageModel(primary, [{ model: first }, { model: second }]);

            await model.doGenerate(OPTIONS);
            await model.doGenerate(OPTIONS);

            expect(primary.doGenerate).toHaveBeenCalledTimes(1);
            expect(first.doGenerate).toHaveBeenCalledTimes(1);
            expect(second.doGenerate).toHaveBeenCalledTimes(2);
        });

        it("moves on when a backup's stream errors before its first content part", async () => {
            const first = fakeModel("first");

            first.doStream.mockImplementation(async () => {
                return {
                    stream: new ReadableStream({
                        pull(controller) {
                            controller.error(gatewayError("infra"));
                        },
                    }),
                };
            });

            const second = fakeModel("second");
            const model = new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: first }, { model: second }]);

            await model.doStream(OPTIONS);

            expect(second.doStream).toHaveBeenCalledTimes(1);
            expect(model.modelId).toBe("second");
        });
    });

    it("presents itself as the primary model until a call falls back", async () => {
        const primary = fakeModel("primary");
        const model = new FallbackLanguageModel(primary, [{ model: fakeModel("backup") }]);

        expect(model.modelId).toBe("primary");
        expect(model.provider).toBe("gateway/test");
        expect(model.supportedUrls).toBe(primary.supportedUrls);

        const failing = new FallbackLanguageModel(fakeModel("primary", gatewayError("infra")), [{ model: fakeModel("backup") }]);

        await failing.doGenerate(OPTIONS);

        expect(failing.modelId).toBe("backup");
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
