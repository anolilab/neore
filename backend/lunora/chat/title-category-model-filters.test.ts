/**
 * `createTitleChat` / `createCategoryChat` send the user's first prompt to a model. That model follows the user's
 * model filter rules: the rules reach `getAgent`, an excluded default gives way to the next allowed model, and a
 * user whose rules allow none keeps the default title and no category (the job ends quietly, nothing is sent).
 */
import { DEFAULT_TITLE_GENERATION_MODEL } from "@neore/ai/constants";
import type { ModelFilterRules } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { internalMutation } from "../_generated/server";
import { UTILITY_FALLBACK_MODELS, withPaidPlanGrant } from "../lib/utility-model";
import { admitCategoryRun, CATEGORY_LEASE_MS, createCategoryChat, createTitleChat } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());
const state = vi.hoisted(() => {
    return { rules: {} as ModelFilterRules };
});
const getAgent = vi.hoisted(() => vi.fn());
/** The next `failures` category writes throw, whichever path writes: the agent client's `updateMetadata` or `updateThread`. */
const categoryWrites = vi.hoisted(() => {
    return { failures: 0 };
});

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

let functionsModule: Record<string, unknown>;

const writeCategoryRow = async (ctx: any, rowThreadId: string, patch: Record<string, unknown>): Promise<void> => {
    if (categoryWrites.failures > 0) {
        categoryWrites.failures -= 1;

        throw new Error("the category write failed");
    }

    await ctx.db.patch("threads", rowThreadId, patch);
};

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    functionsModule = await import("./functions");
    registerModule(registry, "chat_functions", functionsModule);
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
    // The thread write a category delivery makes, failing on demand.
    registry.set(
        "agent_threads:updateThread",
        internalMutation
            .input({ patch: v.object({ category: v.optional(v.string()) }), threadId: v.string() })
            .output(v.null())
            .mutation(async ({ args, ctx }) => {
                await writeCategoryRow(ctx, args.threadId, args.patch);

                return null;
            }),
    );
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    state.rules = {};
    categoryWrites.failures = 0;
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

const ANSWER = { text: "coding", usage: { inputTokens: 1, outputTokens: 1 } };

/** An agent whose model answers through `generate`, and whose thread reads and writes the real row. */
const categoryAgent = (generate: () => Promise<typeof ANSWER>) => {
    return {
        continueThread: async () => {
            return {
                thread: {
                    generateText: generate,
                    getMetadata: async () => await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId)),
                    updateMetadata: async (patch: Record<string, unknown>) =>
                        await harness.run(async (ctx: any) => await writeCategoryRow(ctx, threadId, patch)),
                },
            };
        },
    };
};

const deliver = async (promptId = "prompt-1") =>
    await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", promptId, threadId }));
const categoryOf = async (): Promise<string | undefined> => {
    const row = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

    return row.category;
};

describe("createCategoryChat scheduled by two concurrent resends for one prompt", () => {
    it("makes exactly one model call, though neither delivery has completed when the other starts", async () => {
        let calls = 0;
        // The model answers only once the test lets it: until then the first delivery is still inside its call.
        let answered = false;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;
                await vi.waitFor(
                    () => {
                        expect(answered).toBe(true);
                    },
                    { timeout: 5000 },
                );

                return ANSWER;
            }),
        );

        const first = deliver();

        await vi.waitFor(() => {
            expect(calls).toBe(1);
        });

        // The second ends without a call, refused as in flight for the scheduler's retry; without a claim it reaches the model too.
        const second: Promise<unknown> = deliver().catch((error: unknown) => error);

        await Promise.race([
            second,
            vi.waitFor(() => {
                expect(calls).toBe(2);
            }),
        ]);
        answered = true;
        await first;

        // Only the in-flight conflict, never any other failure, counts as the second delivery standing back.
        expect(await second).toMatchObject({ code: "CONFLICT" });
        expect(calls).toBe(1);
        expect(await categoryOf()).toBe("coding");
    });
});

describe("createCategoryChat after a failed write", () => {
    it("writes the stored answer on the next delivery, with one model call in all", async () => {
        let calls = 0;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;

                return ANSWER;
            }),
        );
        categoryWrites.failures = 1;

        await expect(deliver()).rejects.toThrow("the category write failed");
        await expect(deliver()).resolves.toBeUndefined();

        expect(calls).toBe(1);
        expect(await categoryOf()).toBe("coding");
    });

    it("writes a recorded answer though the model could no longer be set up", async () => {
        let calls = 0;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;

                return ANSWER;
            }),
        );
        categoryWrites.failures = 1;
        await expect(deliver()).rejects.toThrow("the category write failed");

        getAgent.mockRejectedValue(new Error(REACHED));

        await expect(deliver()).resolves.toBeUndefined();
        expect(calls).toBe(1);
        expect(await categoryOf()).toBe("coding");
    });

    it("writes a recorded answer though the user's model filters now allow no model", async () => {
        getAgent.mockResolvedValue(categoryAgent(async () => ANSWER));
        categoryWrites.failures = 1;
        await expect(deliver()).rejects.toThrow("the category write failed");

        state.rules = { allowedModels: ["some/other-model"] };

        await expect(deliver()).resolves.toBeUndefined();
        expect(await categoryOf()).toBe("coding");
    });

    it("lets a later delivery call the model again when the call itself failed", async () => {
        let calls = 0;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;

                if (calls === 1) {
                    throw new Error("the model call failed");
                }

                return { ...ANSWER, text: "math" };
            }),
        );

        await expect(deliver("prompt-2")).rejects.toThrow("the model call failed");
        await expect(deliver("prompt-2")).resolves.toBeUndefined();

        expect(calls).toBe(2);
        expect(await categoryOf()).toBe("math");
    });
});

describe("createCategoryChat with an unanswered claim", () => {
    afterEach(() => {
        vi.useRealTimers();
        registry.delete("chat_functions:recordCategoryAnswer");
        registerModule(registry, "chat_functions", functionsModule);
    });

    it("leaves a claim abandoned before its answer to the scheduler's retry, which takes it over after the lease", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        let calls = 0;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;

                return ANSWER;
            }),
        );
        // A delivery took the claim and died before the model answered.
        await harness.run(async (ctx: any) => await ctx.runMutation(admitCategoryRun, { key: `${threadId}:prompt-1`, userId: "user-1" }));

        // Within the lease the work is in flight: no call, and the job fails so the scheduler retries it.
        await expect(deliver()).rejects.toThrow();
        expect(calls).toBe(0);

        vi.setSystemTime(Date.now() + CATEGORY_LEASE_MS);

        await expect(deliver()).resolves.toBeUndefined();
        expect(calls).toBe(1);
        expect(await categoryOf()).toBe("coding");
    });

    it("finishes after the lease when neither the answer nor the category could be written", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        let calls = 0;

        getAgent.mockResolvedValue(
            categoryAgent(async () => {
                calls += 1;

                return ANSWER;
            }),
        );
        // The answer's record fails, and so does the write.
        registry.set(
            "chat_functions:recordCategoryAnswer",
            internalMutation
                .input({ category: v.string(), claimedAt: v.number(), key: v.string() })
                .output(v.boolean())
                .mutation(async () => {
                    throw new Error("the answer could not be recorded");
                }),
        );
        categoryWrites.failures = 1;

        await expect(deliver()).rejects.toThrow("the category write failed");
        registry.delete("chat_functions:recordCategoryAnswer");
        registerModule(registry, "chat_functions", functionsModule);

        // No answer was kept: in flight until the lease ends, then taken over with one more call.
        await expect(deliver()).rejects.toThrow();
        expect(calls).toBe(1);

        vi.setSystemTime(Date.now() + CATEGORY_LEASE_MS);

        await expect(deliver()).resolves.toBeUndefined();
        expect(calls).toBe(2);
        expect(await categoryOf()).toBe("coding");
    });
});
