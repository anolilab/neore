/**
 * `createTitleChat` / `createCategoryChat` send the user's first prompt to a model. That model follows the user's
 * model filter rules: the rules reach `getAgent`, an excluded default gives way to the next allowed model, and a
 * user whose rules allow none keeps the default title and no category (the job ends quietly, nothing is sent).
 */
import { DEFAULT_TITLE_GENERATION_MODEL } from "@neore/ai/constants";
import type { ModelFilterRules } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { UTILITY_FALLBACK_MODELS, withPaidPlanGrant } from "../lib/utility-model";
import { createCategoryChat, createTitleChat } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());
const state = vi.hoisted(() => {
    return { rules: {} as ModelFilterRules };
});
const getAgent = vi.hoisted(() => vi.fn());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});
vi.mock("./lib/model-filter-rules", () => {
    return { loadModelFilterRules: async () => state.rules };
});
vi.mock("../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/services")>()), gatewayFetch: () => async () => new Response("{}") };
});

const REACHED = "getAgent reached";

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    state.rules = {};
    getAgent.mockReset();
    getAgent.mockRejectedValue(new Error(REACHED));
    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "New Chat", updatedAt: 1, userId: "user-1" }),
    );
});

afterEach(() => {
    harness.close();
});

const runTitle = async () => await harness.action(async (context: any) => await context.runAction(createTitleChat, { prompt: "hi", threadId }));
const runCategory = async () => await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", threadId }));

describe.each([
    ["createTitleChat", runTitle],
    ["createCategoryChat", runCategory],
])("%s under the user's model filter rules", (_name, run) => {
    it("uses the default model, and passes the rules on, when the rules allow it", async () => {
        state.rules = { blockedModels: ["openai/o3"] };

        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(DEFAULT_TITLE_GENERATION_MODEL, expect.objectContaining({ modelFilterRules: { blockedModels: ["openai/o3"] } }));
    });

    it("uses the next allowed model when the rules exclude the default", async () => {
        state.rules = { blockedModels: [DEFAULT_TITLE_GENERATION_MODEL] };

        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(UTILITY_FALLBACK_MODELS[0], expect.anything());
    });

    it("leaves the platform's own default model unmetered, as it always was", async () => {
        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(DEFAULT_TITLE_GENERATION_MODEL, expect.objectContaining({ userId: undefined }));
    });

    it("meters a paid fallback to the user whose plan authorized it", async () => {
        const paid = "anthropic/claude-haiku-4.5";

        state.rules = withPaidPlanGrant({ allowedModels: [paid] }, true);

        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(paid, expect.objectContaining({ userId: "user-1" }));
    });

    it("ends quietly, without reaching any model, when the rules allow none", async () => {
        state.rules = { allowedModels: ["some/other-model"] };

        await expect(run()).resolves.toBeUndefined();

        expect(getAgent).not.toHaveBeenCalled();
    });
});

describe("createCategoryChat scheduled by two concurrent resends for one prompt", () => {
    it("makes exactly one model call, though neither delivery has completed when the other starts", async () => {
        let calls = 0;
        // The model answers only once the test lets it: until then the first delivery is still inside its call.
        let answered = false;
        const updateMetadata = vi.fn(async () => undefined);

        getAgent.mockReset();
        getAgent.mockResolvedValue({
            continueThread: async () => {
                return {
                    thread: {
                        generateText: async () => {
                            calls += 1;
                            await vi.waitFor(
                                () => {
                                    expect(answered).toBe(true);
                                },
                                { timeout: 5000 },
                            );

                            return { text: "coding", usage: { inputTokens: 1, outputTokens: 1 } };
                        },
                        getMetadata: async () => {
                            return {};
                        },
                        updateMetadata,
                    },
                };
            },
        });

        // A resend scheduled the job again before the first delivery wrote its category.
        const deliver = async () =>
            await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", promptId: "prompt-1", threadId }));
        const first = deliver();

        await vi.waitFor(() => {
            expect(calls).toBe(1);
        });

        const second = deliver();

        // The second either ends without a call, or (without a claim) reaches the model too.
        await Promise.race([
            second,
            vi.waitFor(() => {
                expect(calls).toBe(2);
            }),
        ]);
        answered = true;
        await Promise.all([first, second]);

        expect(calls).toBe(1);
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(updateMetadata).toHaveBeenCalledWith({ category: "coding" });
    });
});

describe("createCategoryChat whose category write fails after the model answered", () => {
    it("writes the stored answer on the next delivery, with one model call in all", async () => {
        let calls = 0;
        const updateMetadata = vi.fn(async () => {
            if (updateMetadata.mock.calls.length === 1) {
                throw new Error("the category write failed");
            }
        });

        getAgent.mockReset();
        getAgent.mockResolvedValue({
            continueThread: async () => {
                return {
                    thread: {
                        generateText: async () => {
                            calls += 1;

                            return { text: "coding", usage: { inputTokens: 1, outputTokens: 1 } };
                        },
                        // The failed write left no category behind.
                        getMetadata: async () => {
                            return {};
                        },
                        updateMetadata,
                    },
                };
            },
        });

        const deliver = async () =>
            await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", promptId: "prompt-1", threadId }));

        await expect(deliver()).rejects.toThrow("the category write failed");
        await expect(deliver()).resolves.toBeUndefined();

        expect(calls).toBe(1);
        expect(updateMetadata).toHaveBeenCalledTimes(2);
        expect(updateMetadata).toHaveBeenLastCalledWith({ category: "coding" });
    });

    it("lets a later delivery call the model again when the call itself failed", async () => {
        let calls = 0;
        const updateMetadata = vi.fn(async () => undefined);

        getAgent.mockReset();
        getAgent.mockResolvedValue({
            continueThread: async () => {
                return {
                    thread: {
                        generateText: async () => {
                            calls += 1;

                            if (calls === 1) {
                                throw new Error("the model call failed");
                            }

                            return { text: "math", usage: { inputTokens: 1, outputTokens: 1 } };
                        },
                        getMetadata: async () => {
                            return {};
                        },
                        updateMetadata,
                    },
                };
            },
        });

        const deliver = async () =>
            await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", promptId: "prompt-2", threadId }));

        await expect(deliver()).rejects.toThrow("the model call failed");
        await expect(deliver()).resolves.toBeUndefined();

        expect(calls).toBe(2);
        expect(updateMetadata).toHaveBeenCalledExactlyOnceWith({ category: "math" });
    });
});
