/**
 * Saving imported memories: nothing without memory turned on, provenance on every
 * row, and a repeat of the same list — longer than extraction's 50-row dedup
 * window — adds nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { importFacts, labelImportedText } from "./import";

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
        NO_ALLOWED_UTILITY_MODEL_MESSAGE: "no model",
        NoAllowedUtilityModelError: class extends Error {},
    };
});
// The harness action ctx has no `services`; dedup runs on text here.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return { embedMany };
});
// The harness has no vector index: the search reads the stored vector rows instead.
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
const MEMORY_OFF_RE = /Turn on memory/;
const ITEM_RE = /item (\d+)/;
// Distinct enough wording per row that text dedup never merges two of them.
const FACTS = Array.from({ length: 60 }, (_, index) => {
    return { memory: `The user owns collection item ${String(index)} named ${"xyz".repeat((index % 7) + 1)}${String(index * 31)}`, type: "context" as const };
});

let harness: ReturnType<typeof lunoraTest>;

const setMemoryEnabled = async (memoryEnabled: boolean) =>
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled, timezone: "UTC", userId: USER });
    });

const memories = async () => await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

const save = async (facts: ReadonlyArray<{ memory: string; type: "context" | "identity" }>) =>
    await harness.action(async (ctx: any) => await importFacts(ctx, { app: "gemini", facts, userId: USER }));

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "agent_vector", await import("../agent/vector/index"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    embedMany.mockRejectedValue(new Error("no embeddings in this test"));
});

afterEach(() => {
    harness.close();
    embedMany.mockReset();
    generateText.mockReset();
    searchVectors.mockReset();
});

describe("importing another assistant's memory", () => {
    it("saves nothing and calls no model while memory is off", async () => {
        expect.assertions(3);

        await setMemoryEnabled(false);

        await expect(save(FACTS.slice(0, 3))).rejects.toThrow(MEMORY_OFF_RE);
        await expect(harness.action(async (ctx: any) => await labelImportedText(ctx, USER, "The user is a nurse in Hamburg"))).rejects.toThrow(MEMORY_OFF_RE);
        expect(await memories()).toHaveLength(0);
    });

    it("marks every saved row as imported from the chosen app", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        await save([{ memory: "The user is a nurse in Hamburg", type: "identity" }]);

        const rows = await memories();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ importedFrom: "gemini", memory: "The user is a nurse in Hamburg", source: "imported", type: "identity" });
    });

    it("revises a second fact against the text the first one merged into the same row", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" } })
            .mockResolvedValueOnce({ output: { action: "IGNORE" } });

        await save([
            { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
            { memory: "The user lives in Berlin near the river with a garden and bikes daily often", type: "context" },
        ]);

        expect(generateText).toHaveBeenCalledTimes(2);
        expect(generateText.mock.calls[1]?.[0].prompt).toContain(
            "<existing_memory>The user lives in Berlin near the river with a garden and bikes daily</existing_memory>",
        );
    });

    it("finds an exact repeat the near-match window no longer reads", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        // The window reads by type first: a thousand preferences push the one activity row out of it.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user ran a marathon in Porto", type: "activity", userId: USER });

            for (let index = 0; index < 1000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }
        });

        expect(await save([{ memory: "The user ran a marathon in Porto", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
        expect(await memories()).toHaveLength(1001);
    });

    it("supersedes the row a fact contradicts even when its exact text is found past the window", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const { contradicted, known } = await harness.run(async (ctx: any) => {
            const kept = await ctx.db.insert("memories", { memory: "The user lives in Lisbon near the old harbour", type: "activity", userId: USER });

            for (let index = 0; index < 999; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }

            return {
                contradicted: await ctx.db.insert("memories", {
                    memory: "The user lives in Lisbon near the old harbour today",
                    type: "preference",
                    userId: USER,
                }),
                known: kept,
            };
        });

        generateText.mockResolvedValueOnce({ output: { action: "SUPERSEDE" } });

        expect(await save([{ memory: "The user lives in Lisbon near the old harbour", type: "context" }])).toStrictEqual({
            added: 0,
            alreadyKnown: 1,
            updated: 0,
        });
        const row: { supersededBy?: string } = await harness.run(async (ctx: any) => await ctx.db.get("memories", contradicted));

        expect(row.supersededBy).toBe(known);
    });

    it("saves a fact whose text matches a row the same save superseded", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user works at the harbour office in Porto", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "SUPERSEDE" } });

        await save([
            { memory: "The user works at the harbour office in Porto now", type: "context" },
            { memory: "The user works at the harbour office in Porto", type: "context" },
        ]);

        const rows: { memory: string; supersededBy?: string }[] = await memories();
        const active = rows.filter((row) => !row.supersededBy).map((row) => row.memory);

        expect(active.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "The user works at the harbour office in Porto",
            "The user works at the harbour office in Porto now",
        ]);
    });

    it("never rewrites a pinned row, and saves a fact as new when the merge looks sensitive", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden", pinned: true, type: "context", userId: USER });
            await ctx.db.insert("memories", { memory: "The user banks with a small cooperative bank in Bremen", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user banks in Bremen, password: hunter22" } });

        expect(
            await save([
                { memory: "The user lives in Berlin near the river with a garden now", type: "context" },
                { memory: "The user banks with a small cooperative bank in Bremen now", type: "context" },
            ]),
        ).toStrictEqual({ added: 2, alreadyKnown: 0, updated: 0 });
        expect(generateText).toHaveBeenCalledOnce();
        const rows: { memory: string }[] = await memories();

        expect(rows.some((row) => row.memory.includes("hunter22"))).toBe(false);
    });

    it("does not count a bot's memory as the user's own", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            const botId = await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "m",
                name: "Ada",
                updatedAt: 1,
                userId: USER,
            });

            await ctx.db.insert("memories", { botId, memory: "The user is a nurse in Hamburg", type: "identity", userId: USER });
        });

        expect(await save([{ memory: "The user is a nurse in Hamburg", type: "identity" }])).toStrictEqual({ added: 1, alreadyKnown: 0, updated: 0 });
    });

    it("saves a paste once when two saves of it run at the same time", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);

        await Promise.all([save(FACTS.slice(0, 10)), save(FACTS.slice(0, 10))]);

        expect(await memories()).toHaveLength(10);
    });

    it("stores each fact's vector and confirms a reworded repeat by it", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);
        // One axis per item number: a reworded fact has the same vector as its original.
        const vectorOf = (text: string) => Array.from({ length: 128 }, (_, axis) => (axis === Number(ITEM_RE.exec(text)?.[1]) ? 1 : 0));
        const reworded = FACTS.slice(0, 5).map((_, index) => {
            return { memory: `Collection item ${String(index)} belongs to them`, type: "context" as const };
        });

        embedMany.mockImplementation(async (_ctx: unknown, { values }: { values: string[] }) => {
            return { embeddings: values.map((value) => vectorOf(value)) };
        });
        searchVectors.mockImplementation(async (_ctx: unknown, vector: number[]) => {
            const rows = await harness.run(async (ctx: any) => await ctx.db.query("embeddings_128").collect());

            return rows
                .map((row: { _id: string; vector: number[] }) => {
                    return { _id: row._id, _score: row.vector.reduce((sum, value, axis) => sum + value * (vector[axis] ?? 0), 0) };
                })
                .toSorted((a: { _score: number }, b: { _score: number }) => b._score - a._score);
        });

        await save(FACTS.slice(0, 5));

        const saved: { embeddingId?: string }[] = await memories();

        expect(saved.every((row) => row.embeddingId)).toBe(true);
        expect(await save(reworded)).toStrictEqual({ added: 0, alreadyKnown: 5, updated: 0 });
        expect(searchVectors).toHaveBeenCalledTimes(5);
    });

    it("adds nothing when the same long list is imported again", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        expect(await save(FACTS)).toStrictEqual({ added: 60, alreadyKnown: 0, updated: 0 });
        expect(await save(FACTS)).toStrictEqual({ added: 0, alreadyKnown: 60, updated: 0 });
        expect(await memories()).toHaveLength(60);
    });
});
