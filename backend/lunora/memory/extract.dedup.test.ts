/**
 * Extraction's vector dedup: vectors are shared by the user and their bots, so a hit from
 * the other scope is passed over, and the run's own row past the 50-row window is read by
 * its vector id instead of being taken as "no match".
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { extractMemories } from "./extract";

const { embedMany, generateText, registry, searchVectors } = vi.hoisted(() => {
    return { embedMany: vi.fn(), generateText: vi.fn(), registry: new Map<string, unknown>(), searchVectors: vi.fn() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
        NoAllowedUtilityModelError: class extends Error {},
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return { embedMany };
});
vi.mock("../agent/vector/index", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../agent/vector/index")>()), searchVectors };
});
vi.mock("../chat/lib/gateway-embedding-model", () => {
    return {
        createGatewayEmbeddingModel: () => {
            return {};
        },
        embeddingModelAllowed: () => true,
    };
});

const USER = "user-a";
const FACT = "The user owns a blue vase from Lisbon";
const VECTOR = Array.from({ length: 128 }, (_, axis) => (axis === 0 ? 1 : 0));

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
    registerModule(registry, "agent_vector", await import("../agent/vector/index"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    embedMany.mockImplementation(async (_ctx: unknown, { values }: { values: string[] }) => {
        return { embeddings: values.map(() => VECTOR) };
    });
    generateText.mockResolvedValue({ output: { facts: [{ confidence: 90, importance: 80, memory: FACT, type: "activity" }] } });

    threadId = await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });

        return await ctx.db.insert("threads", { status: "regular", title: "Vases", updatedAt: Date.now(), userId: USER });
    });
});

afterEach(() => {
    harness.close();
    embedMany.mockReset();
    generateText.mockReset();
    searchVectors.mockReset();
});

describe("extraction vector dedup", () => {
    it("passes over another scope's hit and confirms the user's own row past the window", async () => {
        expect.assertions(3);

        const { botRow, ownRow } = await harness.run(async (ctx: any) => {
            const botId = await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "m",
                name: "Ada",
                updatedAt: 1,
                userId: USER,
            });
            const botVector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });
            const ownVector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([
                { _id: botVector, _score: 1 },
                { _id: ownVector, _score: 0.97 },
            ]);

            const ids = {
                botRow: await ctx.db.insert("memories", { botId, embeddingId: botVector, memory: FACT, type: "activity", userId: USER }),
                // The window reads by type first: newer preferences push the activity row out of its 50.
                ownRow: await ctx.db.insert("memories", { embeddingId: ownVector, memory: "The user owns a blue Lisbon vase", type: "activity", userId: USER }),
            };

            for (let index = 0; index < 60; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }

            return ids;
        });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I bought a blue vase in Lisbon, please remember that about me",
                }),
        );

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

        expect(rows).toHaveLength(62);
        expect(rows.find((row: { _id: string }) => row._id === ownRow)?.lastConfirmedAt).toBeTypeOf("number");
        expect(rows.find((row: { _id: string }) => row._id === botRow)?.lastConfirmedAt).toBeUndefined();
    });

    it("never revises a pinned row, and saves the fact beside it", async () => {
        expect.assertions(2);

        const pinned = await harness.run(async (ctx: any) => {
            const vector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([{ _id: vector, _score: 0.9 }]);

            return await ctx.db.insert("memories", {
                embeddingId: vector,
                memory: "The user owns a blue vase",
                pinned: true,
                type: "activity",
                userId: USER,
            });
        });

        generateText
            .mockResolvedValueOnce({ output: { facts: [{ confidence: 90, importance: 80, memory: FACT, type: "activity" }] } })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: `${FACT} and keeps it on a shelf` } });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I bought a blue vase in Lisbon, please remember that about me",
                }),
        );

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

        expect(rows.find((row: { _id: string }) => row._id === pinned)?.memory).toBe("The user owns a blue vase");
        expect(rows).toHaveLength(2);
    });

    it("schedules a new vector for a row an extraction merged into", async () => {
        expect.assertions(1);

        const rowId = await harness.run(async (ctx: any) => {
            const vector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([{ _id: vector, _score: 0.9 }]);

            return await ctx.db.insert("memories", { embeddingId: vector, memory: "The user owns a blue vase", type: "activity", userId: USER });
        });

        generateText
            .mockResolvedValueOnce({ output: { facts: [{ confidence: 90, importance: 80, memory: FACT, type: "activity" }] } })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: `${FACT} and keeps it on a shelf` } });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I bought a blue vase in Lisbon, please remember that about me",
                }),
        );

        expect(harness.scheduler.list().map((job) => job.args)).toContainEqual({ memoryId: rowId, userId: USER });
    });

    it("revises a row once per run, comparing a second fact to the text the first revision wrote", async () => {
        expect.assertions(2);

        const rowId = await harness.run(async (ctx: any) => {
            const vector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([{ _id: vector, _score: 0.9 }]);

            return await ctx.db.insert("memories", { embeddingId: vector, memory: "The user owns a blue vase", type: "activity", userId: USER });
        });

        generateText
            .mockResolvedValueOnce({
                output: {
                    facts: [
                        { confidence: 90, importance: 80, memory: "The user owns a blue vase from Lisbon", type: "activity" },
                        { confidence: 90, importance: 80, memory: "The user owns a blue vase from Lisbon today", type: "activity" },
                    ],
                },
            })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user owns a blue vase from Lisbon" } })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user owns a blue vase from Lisbon today" } });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I bought a blue vase in Lisbon, please remember that about me",
                }),
        );

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

        expect(rows).toHaveLength(1);
        expect(rows.find((row: { _id: string }) => row._id === rowId)?.memory).toBe("The user owns a blue vase from Lisbon today");
    });

    it("keeps the higher confidence a row's first revision set when a later, less confident fact revises it again", async () => {
        expect.assertions(1);

        const rowId = await harness.run(async (ctx: any) => {
            const vector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([{ _id: vector, _score: 0.9 }]);

            return await ctx.db.insert("memories", {
                confidence: 50,
                embeddingId: vector,
                memory: "The user owns a blue vase",
                type: "activity",
                userId: USER,
            });
        });

        generateText
            .mockResolvedValueOnce({
                output: {
                    facts: [
                        { confidence: 90, importance: 80, memory: "The user owns a blue vase from Lisbon", type: "activity" },
                        { confidence: 40, importance: 80, memory: "The user owns a blue vase from Lisbon today", type: "activity" },
                    ],
                },
            })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user owns a blue vase from Lisbon" } })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user owns a blue vase from Lisbon today" } });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I bought a blue vase in Lisbon, please remember that about me",
                }),
        );

        const row = await harness.run(async (ctx: any) => await ctx.db.get("memories", rowId));

        expect(row?.confidence).toBe(90);
    });

    it("does not revise a row an earlier fact of the run supersedes, so no two active rows contradict each other", async () => {
        expect.assertions(3);

        const rowId = await harness.run(async (ctx: any) => {
            const vector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: VECTOR });

            searchVectors.mockResolvedValue([{ _id: vector, _score: 0.9 }]);

            return await ctx.db.insert("memories", { embeddingId: vector, memory: "The user owns a blue vase", type: "activity", userId: USER });
        });

        generateText
            .mockResolvedValueOnce({
                output: {
                    facts: [
                        { confidence: 90, importance: 80, memory: "The user sold the blue vase in Lisbon", type: "activity" },
                        { confidence: 90, importance: 80, memory: "The user owns a blue vase from Lisbon today", type: "activity" },
                    ],
                },
            })
            .mockResolvedValueOnce({ output: { action: "SUPERSEDE" } });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "A lovely vase.",
                    threadId,
                    userId: USER,
                    userMessage: "I sold my blue vase in Lisbon, please remember that about me",
                }),
        );

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
        const active = rows.filter((row: { supersededBy?: string }) => !row.supersededBy);

        expect(rows).toHaveLength(3);
        expect(rows.find((row: { _id: string }) => row._id === rowId)?.supersededBy).toBeTypeOf("string");
        expect(active.map((row: { memory: string }) => row.memory).toSorted()).toStrictEqual([
            "The user owns a blue vase from Lisbon today",
            "The user sold the blue vase in Lisbon",
        ]);
    });
});
