/**
 * Saving imported memories: nothing without memory turned on, provenance on every
 * row, and a repeat of the same list — longer than extraction's 50-row dedup
 * window — adds nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internal } from "../_generated/internal";
import schema from "../schema";
import { REDACTED } from "../lib/secret-redaction";
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
        getUtilityModelForUser: async () => {
            return {};
        },
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
/** Assembled at runtime so the file holds no literal that reads as a real credential; no line rule names its shape. */
const TOKEN = ["Zq8LmV2xR7tYw4", "KpN3bC9dF6hJ1sA5gE0uIo"].join("");
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

/** The stored row with this id, read back after a save. */
const rowOf = async (id: unknown): Promise<{ confidence?: number; embeddingId?: string; lastConfirmedAt?: number; memory: string } | undefined> => {
    const rows: { _id: string }[] = await memories();

    return rows.find((row) => row._id === id) as { confidence?: number; embeddingId?: string; lastConfirmedAt?: number; memory: string } | undefined;
};

const save = async (facts: ReadonlyArray<{ memory: string; type: "context" | "identity" }>) =>
    await harness.action(async (ctx: any) => await importFacts(ctx, { app: "gemini", facts, userId: USER }));

// One axis per item number: a reworded fact has the same vector as its original.
const vectorOf = (text: string) => Array.from({ length: 128 }, (_, axis) => (axis === Number(ITEM_RE.exec(text)?.[1]) ? 1 : 0));

/** Embeds by item number and searches the stored vector rows, as the harness has no vector index. */
const useFakeVectors = () => {
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
};

/** A stored vector at cosine 0.9 to `item <n>`: a near-match that goes to belief revision, not a duplicate. */
const nearVectorOf = (item: number) => {
    const vector = Array.from({ length: 128 }, (_, axis): number => (axis === item ? 0.9 : 0));

    vector[127] = Math.sqrt(1 - 0.81);

    return vector;
};

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
            // Stored with stray spacing, which the match ignores.
            await ctx.db.insert("memories", { memory: "The user ran a  marathon in Porto ", type: "activity", userId: USER });

            for (let index = 0; index < 1000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }
        });

        expect(await save([{ memory: "The user ran a marathon in Porto", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
        expect(await memories()).toHaveLength(1001);
    });

    it("confirms an exact repeat found past the near-match window instead of superseding a near row", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const { contradicted } = await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Lisbon near the old harbour", type: "activity", userId: USER });

            for (let index = 0; index < 999; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }

            return {
                contradicted: await ctx.db.insert("memories", {
                    memory: "The user lives in Lisbon near the old harbour today",
                    type: "preference",
                    userId: USER,
                }),
            };
        });

        // The exact row is the best match once it is in the window, so no revision is asked and the near row stays active.
        expect(await save([{ memory: "The user lives in Lisbon near the old harbour", type: "context" }])).toStrictEqual({
            added: 0,
            alreadyKnown: 1,
            updated: 0,
        });
        const row: { supersededBy?: string } = await harness.run(async (ctx: any) => await ctx.db.get("memories", contradicted));

        expect(row.supersededBy).toBeUndefined();
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

    it("saves a fact as new instead of cutting a merge too long to store", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user banks with a small cooperative bank in Bremen", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: `The user banks in Bremen ${"and much more ".repeat(60)}` } });

        expect(await save([{ memory: "The user banks with a small cooperative bank in Bremen now", type: "context" }])).toStrictEqual({
            added: 1,
            alreadyKnown: 0,
            updated: 0,
        });

        const rows: { memory: string }[] = await memories();

        expect(rows.map((row) => row.memory)).toContain("The user banks with a small cooperative bank in Bremen");
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

    it("writes nothing when memory is turned off while the save runs", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        embedMany.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                const settings = await ctx.db.query("userSettings").first();

                await ctx.db.patch("userSettings", settings._id, { memoryEnabled: false });
            });

            throw new Error("no embeddings in this test");
        });

        await expect(save(FACTS.slice(0, 3))).rejects.toThrow(MEMORY_OFF_RE);
        expect(await memories()).toHaveLength(0);
    });

    it("leaves merges and confirmations unwritten when memory is turned off while the save runs", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        const [known, merged] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", { memory: "The user is a nurse in Hamburg", type: "identity", userId: USER }),
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        ]);

        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                const settings = await ctx.db.query("userSettings").first();

                await ctx.db.patch("userSettings", settings._id, { memoryEnabled: false });
            });

            return { output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" } };
        });

        await expect(
            save([
                { memory: "The user is a nurse in Hamburg", type: "identity" },
                { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
            ]),
        ).rejects.toThrow(MEMORY_OFF_RE);

        const rows = await memories();

        expect(rows.find((row: { _id: string }) => row._id === known)?.lastConfirmedAt).toBeUndefined();
        expect(rows.find((row: { _id: string }) => row._id === merged)?.memory).toBe("The user lives in Berlin near the river with a garden and bikes");
    });

    it("neither confirms a row edited while the save ran nor supersedes one pinned meanwhile", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        const [known, contradicted] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", { memory: "The user is a nurse in Hamburg", type: "identity", userId: USER }),
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        ]);

        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("memories", known, { memory: "The user is a nurse in Bremen" });
                await ctx.db.patch("memories", contradicted, { pinned: true });
            });

            return { output: { action: "SUPERSEDE" } };
        });

        await save([
            { memory: "The user is a nurse in Hamburg", type: "identity" },
            { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
        ]);

        const rows = await memories();

        expect(rows.find((row: { _id: string }) => row._id === known)?.lastConfirmedAt).toBeUndefined();
        expect(rows.find((row: { _id: string }) => row._id === contradicted)?.supersededBy).toBeUndefined();
        // The confirmation was skipped, so the fact is saved as new rather than dropped.
        expect(rows).toHaveLength(4);
    });

    it("does not supersede a row edited while the save ran", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        const rowId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        );

        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("memories", rowId, { memory: "The user lives in Berlin near the river with a garden" });
            });

            return { output: { action: "SUPERSEDE" } };
        });

        await save([{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }]);

        const rows = await memories();

        expect(rows).toHaveLength(2);
        expect(rows.find((row: { _id: string }) => row._id === rowId)?.supersededBy).toBeUndefined();
        expect(rows.find((row: { _id: string }) => row._id !== rowId)?.supersedes).toBeUndefined();
    });

    it("saves the fact as new when its merge row was edited while the save ran", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        const rowId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        );

        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("memories", rowId, { memory: "The user lives in Berlin near the river with a garden" });
            });

            return { output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" } };
        });

        expect(await save([{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }])).toStrictEqual({
            added: 1,
            alreadyKnown: 0,
            updated: 0,
        });

        const rows = await memories();

        expect(rows.find((row: { _id: string }) => row._id === rowId)?.memory).toBe("The user lives in Berlin near the river with a garden");
        expect(harness.scheduler.list()).toHaveLength(0);
    });

    it("saves nothing for a line that is only a secret", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        expect(await save([{ memory: TOKEN, type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 0, updated: 0 });
        expect(await memories()).toHaveLength(0);
    });

    it("stores no secret in a row a fact merged into", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({
            output: { action: "UPDATE", mergedMemory: `The user lives in Berlin near the river with a garden and bikes, gate code ${TOKEN}` },
        });

        await save([{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }]);

        const rows = await memories();

        expect(rows.map((row: { memory: string }) => row.memory)).toStrictEqual([
            `The user lives in Berlin near the river with a garden and bikes, gate code ${REDACTED}`,
        ]);
    });

    it("saves the fact as new when its merged text is only a secret", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: TOKEN } });

        const events: [string, unknown][] = [];

        expect(
            await harness.action(async (ctx: any) => {
                vi.spyOn(ctx.log, "event").mockImplementation((...call: unknown[]) => {
                    events.push([call[0] as string, call[1]]);
                });

                return await importFacts(ctx, {
                    app: "gemini",
                    facts: [{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }],
                    userId: USER,
                });
            }),
        ).toStrictEqual({ added: 1, alreadyKnown: 0, updated: 0 });
        // The revision ran and its secret-only merge was refused; the default path would add the fact without it.
        expect(generateText).toHaveBeenCalledOnce();
        // Nothing the save wrote lost a secret: the refused merge is not counted.
        expect(events).toStrictEqual([]);
    });

    it("logs a merge that lost a secret, counts only", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({
            output: { action: "UPDATE", mergedMemory: `The user lives in Berlin near the river with a garden and bikes, gate code ${TOKEN}` },
        });

        const events: [string, unknown][] = [];

        await harness.action(async (ctx: any) => {
            vi.spyOn(ctx.log, "event").mockImplementation((...call: unknown[]) => {
                events.push([call[0] as string, call[1]]);
            });

            return await importFacts(ctx, {
                app: "gemini",
                facts: [{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }],
                userId: USER,
            });
        });

        expect(events).toStrictEqual([["memory.secret_redaction", { dropped: 0, path: "import", redacted: 1 }]]);
    });

    it("saves the fact as new when the save finds its merged text is only a secret", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const { saveImportedMemoryBatch } = await import("./functions");
        const base = "The user lives in Berlin near the river with a garden and bikes";
        const target = await harness.run(async (ctx: any) => await ctx.db.insert("memories", { memory: base, type: "context", userId: USER }));
        const fact = "The user lives in Berlin near the river with a garden and bikes daily";
        const outcomes = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveImportedMemoryBatch, {
                    app: "gemini",
                    confirms: [],
                    facts: [{ memory: fact, merge: { base, confidence: 60, memory: `API_KEY=${TOKEN}`, memoryId: target }, type: "context" }],
                    userId: USER,
                }),
        );
        const rows = await memories();

        expect(outcomes).toStrictEqual({ confirms: [], facts: [{ memoryId: expect.any(String), status: "added" }] });
        expect(rows.map((row: { memory: string }) => row.memory).toSorted()).toStrictEqual([base, fact].toSorted());
    });

    it("confirms the row that already holds a merge's text once redacted, and keeps the target's text", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const { saveImportedMemoryBatch } = await import("./functions");
        const { redactMemoryText } = await import("./redact");
        const merged = `The user's CI publishes the site with ${TOKEN} every night`;
        const base = "The user's CI publishes the site every night";
        const { target, twin } = await harness.run(async (ctx: any) => {
            return {
                target: await ctx.db.insert("memories", { memory: base, type: "context", userId: USER }),
                twin: await ctx.db.insert("memories", { memory: redactMemoryText(merged), type: "context", userId: USER }),
            };
        });
        const outcomes = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveImportedMemoryBatch, {
                    app: "gemini",
                    confirms: [],
                    facts: [
                        {
                            memory: "The user's CI publishes the site nightly",
                            merge: { base, confidence: 60, memory: merged, memoryId: target },
                            type: "context",
                        },
                    ],
                    userId: USER,
                }),
        );

        expect(outcomes).toStrictEqual({ confirms: [], facts: [{ memoryId: twin, status: "known" }] });
        expect((await memories()).find((row: { _id: string }) => row._id === target)?.memory).toBe(base);
    });

    it("reports a confirmation that cannot apply and is only a secret as dropped, and saves nothing for it", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const { saveImportedMemoryBatch } = await import("./functions");
        const row = await harness.run(async (ctx: any) => await ctx.db.insert("memories", { memory: "The user likes tea", type: "preference", userId: USER }));
        const outcomes = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveImportedMemoryBatch, {
                    app: "gemini",
                    confirms: [{ base: "The user likes green tea", memory: `API_KEY=${TOKEN}`, memoryId: row, type: "preference" }],
                    facts: [],
                    userId: USER,
                }),
        );

        expect(outcomes).toStrictEqual({ confirms: [{ memoryId: null, status: "dropped" }], facts: [] });
        expect((await memories()).map((memory: { memory: string }) => memory.memory)).toStrictEqual(["The user likes tea"]);
    });

    it("schedules a new vector for a merged row", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const rowId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        );

        generateText.mockResolvedValueOnce({
            output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" },
        });

        expect(await save([{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }])).toStrictEqual({
            added: 0,
            alreadyKnown: 0,
            updated: 1,
        });
        expect(harness.scheduler.list().map((job) => job.args)).toStrictEqual([{ memoryId: rowId, userId: USER }]);
    });

    it("schedules one new vector for a row two facts merge into", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" } })
            .mockResolvedValueOnce({
                output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily often" },
            });

        expect(
            await save([
                { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
                { memory: "The user lives in Berlin near the river with a garden and bikes daily often", type: "context" },
            ]),
        ).toStrictEqual({ added: 0, alreadyKnown: 0, updated: 2 });
        expect(harness.scheduler.list()).toHaveLength(1);
    });

    it("saves the fact when the row it would supersede is gone by the time of the save", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user works at the harbour office in Porto", type: "context", userId: USER });
        });
        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                const row = await ctx.db.query("memories").first();

                await ctx.db.delete("memories", row._id);
            });

            return { output: { action: "SUPERSEDE" } };
        });

        expect(await save([{ memory: "The user works at the harbour office in Porto now", type: "context" }])).toStrictEqual({
            added: 1,
            alreadyKnown: 0,
            updated: 0,
        });
    });

    it("keeps two checked facts of one paste that differ only in a date", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);

        const fact = (year: number) => {
            return {
                memory: `The user moved with their partner, two children, an old grey cat and a large collection of vinyl records from a small rented flat above a bakery in central Hamburg to a narrow stone house with a walled garden, a lemon tree and a view of the river in Lisbon in ${String(year)}`,
                type: "context" as const,
            };
        };

        expect(await save([fact(2023), fact(2024)])).toMatchObject({ added: 2 });
    });

    it("does not let a bot's newer rows push the user's own fact out of the exact check", async () => {
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

            await ctx.db.insert("memories", { memory: "The user ran a marathon in Porto", type: "activity", userId: USER });

            for (let index = 0; index < 1000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }

            for (let index = 0; index < 5000; index += 1) {
                await ctx.db.insert("memories", { botId, memory: `Bot note number ${String(index)}`, type: "context", userId: USER });
            }
        });

        expect(await save([{ memory: "The user ran a marathon in Porto", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
    });

    it("finds a repeat of the user's newest memory whatever its type", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        // Five thousand older preferences sort ahead of an activity in a type-first read.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 5000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }

            await ctx.db.insert("memories", { memory: "The user ran a marathon in Porto", type: "activity", userId: USER });
        });

        expect(await save([{ memory: "The user ran a marathon in Porto", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
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
        useFakeVectors();

        const reworded = FACTS.slice(0, 5).map((_, index) => {
            return { memory: `Collection item ${String(index)} belongs to them`, type: "context" as const };
        });

        await save(FACTS.slice(0, 5));

        const saved: { embeddingId?: string }[] = await memories();

        expect(saved.every((row) => row.embeddingId)).toBe(true);

        searchVectors.mockClear();

        expect(await save(reworded)).toStrictEqual({ added: 0, alreadyKnown: 5, updated: 0 });
        expect(searchVectors).toHaveBeenCalledTimes(5);
    });

    it("confirms a reworded repeat by its vector when the row is past the near-match window", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        useFakeVectors();
        // The window reads by type first: a thousand preferences push the one activity row out of it.
        await harness.run(async (ctx: any) => {
            const embeddingId = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 7") });

            await ctx.db.insert("memories", { embeddingId, memory: "The user owns collection item 7 named teal", type: "activity", userId: USER });

            for (let index = 0; index < 1000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }
        });

        expect(await save([{ memory: "Collection item 7 belongs to them", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
    });

    it("does not match a later fact by vector to a row an earlier fact superseded", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        useFakeVectors();
        await harness.run(async (ctx: any) => {
            const embeddingId = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: nearVectorOf(3) });

            await ctx.db.insert("memories", { embeddingId, memory: "The user keeps collection item 3 in the hall", type: "context", userId: USER });
            // Keeps the window from emptying once the row above is superseded.
            await ctx.db.insert("memories", { memory: "The user has a cat named Mo", type: "identity", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "SUPERSEDE" } }).mockResolvedValueOnce({ output: { action: "IGNORE" } });

        expect(
            await save([
                { memory: "The user keeps collection item 3 in the hall now", type: "context" },
                { memory: "Collection item 3 is in their hallway", type: "context" },
            ]),
        ).toStrictEqual({ added: 2, alreadyKnown: 0, updated: 0 });
        expect(generateText).toHaveBeenCalledOnce();
    });

    it("compares a later fact by words, not by the old vector, once an earlier fact reworded the row", async () => {
        expect.assertions(1);

        await setMemoryEnabled(true);
        useFakeVectors();
        // The first fact is a near-match (0.9) and is merged; the second scores 1 against the row's old vector.
        embedMany.mockImplementation(async (_ctx: unknown, { values }: { values: string[] }) => {
            return { embeddings: values.map((value) => (value.includes("by the door") ? nearVectorOf(3) : vectorOf(value))) };
        });
        await harness.run(async (ctx: any) => {
            const embeddingId = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 3") });

            await ctx.db.insert("memories", { embeddingId, memory: "The user keeps collection item 3 in the hall", type: "context", userId: USER });
        });
        generateText.mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user keeps collection item 3 in the hall by the door" } });

        expect(
            await save([
                { memory: "The user keeps collection item 3 in the hall by the door", type: "context" },
                { memory: "Collection item 3 is kept in the hallway", type: "context" },
            ]),
        ).toStrictEqual({ added: 1, alreadyKnown: 0, updated: 1 });
    });

    it("passes over a bot's vector hit to the user's own row past the window", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        useFakeVectors();
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
            const botVector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 9") });
            const ownVector = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: nearVectorOf(9) });

            await ctx.db.insert("memories", { botId, embeddingId: botVector, memory: "Collection item 9 is a blue vase", type: "context", userId: USER });
            await ctx.db.insert("memories", { embeddingId: ownVector, memory: "The user owns collection item 9, a blue vase", type: "activity", userId: USER });

            for (let index = 0; index < 1000; index += 1) {
                await ctx.db.insert("memories", { memory: `Preference number ${String(index)} of the user`, type: "preference", userId: USER });
            }
        });
        generateText.mockResolvedValueOnce({ output: { action: "IGNORE" } });

        expect(await save([{ memory: "Collection item 9 is the user's blue vase", type: "context" }])).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
        expect(generateText.mock.calls[0]?.[0].prompt).toContain("<existing_memory>The user owns collection item 9, a blue vase</existing_memory>");
    });

    it("adds nothing when the same long list is imported again", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        expect(await save(FACTS)).toStrictEqual({ added: 60, alreadyKnown: 0, updated: 0 });
        expect(await save(FACTS)).toStrictEqual({ added: 0, alreadyKnown: 60, updated: 0 });
        expect(await memories()).toHaveLength(60);
    });
});

describe("import limits", () => {
    it("counts a confirmation the save could not apply as added, and saves its fact", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        const [nurse, berlin] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", { memory: "The user is a nurse in Hamburg", type: "identity", userId: USER }),
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER }),
        ]);

        // The first fact is planned as a confirmation of the nurse row; the second fact's revision edits that row before the save.
        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("memories", nurse, { memory: "The user is a nurse in Bremen" });
            });

            return { output: { action: "SUPERSEDE" } };
        });

        const result = await save([
            { memory: "The user is a nurse in Hamburg", type: "identity" },
            { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
        ]);

        const rows = await memories();

        expect(result).toStrictEqual({ added: 2, alreadyKnown: 0, updated: 0 });
        expect(rows.find((row: { _id: string }) => row._id === berlin)?.supersededBy).toBeTypeOf("string");
        expect(rows.filter((row: { memory: string }) => row.memory === "The user is a nurse in Hamburg")).toHaveLength(1);
    });

    it("confirms the row a merge would duplicate instead of rewording its own row into a copy", async () => {
        expect.assertions(4);

        await setMemoryEnabled(true);

        const [nurse, cycling] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", {
                memory: "The user is a nurse in the city hospital on the night shift every week",
                type: "identity",
                userId: USER,
            }),
            await ctx.db.insert("memories", { memory: "The user enjoys cycling along the river every morning", type: "context", userId: USER }),
        ]);

        generateText.mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user enjoys cycling along the river every morning" } });

        const result = await save([{ memory: "The user is a nurse in the city hospital on the night shift every weekend", type: "identity" }]);
        const rows = await memories();

        expect(result).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 0 });
        expect(rows).toHaveLength(2);
        expect(rows.find((row: { _id: string }) => row._id === nurse)?.memory).toBe("The user is a nurse in the city hospital on the night shift every week");
        expect(rows.find((row: { _id: string }) => row._id === cycling)?.lastConfirmedAt).toBeTypeOf("number");
    });

    it("finds a near-match past the 1000-row window when no fact has an embedding", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        // The window reads newest first, so the bees row is pinned to an earlier clock than the filler rows.
        vi.useFakeTimers({ toFake: ["Date"] });

        try {
            vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

            const bees = await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("memories", {
                        memory: "The user keeps bees in a small garden behind the old workshop",
                        type: "context",
                        userId: USER,
                    }),
            );

            vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));

            await harness.run(async (ctx: any) => {
                for (let index = 0; index < 1000; index += 1) {
                    await ctx.db.insert("memories", {
                        memory: `The user collects stamp number ${String(index)} from a far country`,
                        type: "context",
                        userId: USER,
                    });
                }
            });

            generateText.mockResolvedValueOnce({ output: { action: "IGNORE" } });

            expect(await save([{ memory: "The user keeps bees in a small garden behind the old workshop yearly", type: "context" }])).toStrictEqual({
                added: 0,
                alreadyKnown: 1,
                updated: 0,
            });
            expect(await memories()).toHaveLength(1001);

            const row = await rowOf(bees);

            expect(row?.lastConfirmedAt).toBeTypeOf("number");
        } finally {
            vi.useRealTimers();
        }
    });

    it("finds a near-match older than more superseded history than the window can scan", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const bees = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", {
                    memory: "The user keeps bees in a small garden behind the old workshop",
                    type: "context",
                    userId: USER,
                }),
        );

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 2100; index += 1) {
                await ctx.db.insert("memories", {
                    memory: `The user kept stamp ${String(index)} from a far country`,
                    supersededBy: bees,
                    type: "context",
                    userId: USER,
                });
            }
        });

        generateText.mockResolvedValueOnce({ output: { action: "IGNORE" } });

        expect(await save([{ memory: "The user keeps bees in a small garden behind the old workshop yearly", type: "context" }])).toStrictEqual({
            added: 0,
            alreadyKnown: 1,
            updated: 0,
        });
        const row = await rowOf(bees);

        expect(row?.lastConfirmedAt).toBeTypeOf("number");
    });

    it("looks up at most ten facts by vector in one save", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        useFakeVectors();

        const facts = FACTS.slice(0, 30);

        expect(await save(facts)).toStrictEqual({ added: 30, alreadyKnown: 0, updated: 0 });
        // Each lookup is a vector query plus a row read, so the count bounds a save's subrequests.
        expect(searchVectors.mock.calls.length).toBeLessThanOrEqual(10);
    });

    it("does not revise a pinned row, and saves the fact beside it", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        const pinned = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", {
                    memory: "The user lives in Berlin near the river with a garden and bikes",
                    pinned: true,
                    type: "context",
                    userId: USER,
                }),
        );

        generateText.mockResolvedValueOnce({
            output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" },
        });

        expect(await save([{ memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" }])).toStrictEqual({
            added: 1,
            alreadyKnown: 0,
            updated: 0,
        });

        const row = await rowOf(pinned);

        expect(row?.memory).toBe("The user lives in Berlin near the river with a garden and bikes");
    });
});

describe("linking a vector to its memory", () => {
    it("links a vector only while the memory still reads as the text it embeds", async () => {
        expect.assertions(3);

        const [memoryId, embeddingId] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", { memory: "The user now reads the new text", type: "context", userId: USER }),
            await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 1") }),
        ]);

        await harness.action(
            async (ctx: any) =>
                await ctx.runMutation(internal.memory.functions.linkMemoryEmbeddings, {
                    links: [{ embeddingId: String(embeddingId), memoryId, text: "The user read the old text" }],
                    userId: USER,
                }),
        );

        const rejectedRow = await rowOf(memoryId);

        expect(rejectedRow?.embeddingId).toBeUndefined();
        expect(await harness.run(async (ctx: any) => await ctx.db.get("embeddings_128", embeddingId))).toBeNull();

        await harness.action(
            async (ctx: any) =>
                await ctx.runMutation(internal.memory.functions.linkMemoryEmbeddings, {
                    links: [{ embeddingId: String(embeddingId), memoryId, text: "The user now reads the new text" }],
                    userId: USER,
                }),
        );

        const linkedRow = await rowOf(memoryId);

        expect(linkedRow?.embeddingId).toBe(String(embeddingId));
    });
});

describe("import writes in one batch", () => {
    it("keeps a row a merge confirmed as a twin when a later fact in the same save would supersede it", async () => {
        expect.assertions(4);

        await setMemoryEnabled(true);

        const [nurse, cycling] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("memories", {
                memory: "The user is a nurse in the city hospital on the night shift every week",
                type: "identity",
                userId: USER,
            }),
            await ctx.db.insert("memories", { memory: "The user enjoys cycling along the river every morning", type: "context", userId: USER }),
        ]);

        generateText
            .mockResolvedValueOnce({ output: { action: "SUPERSEDE" } })
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user enjoys cycling along the river every morning" } });

        const result = await save([
            { memory: "The user enjoys cycling along the river every morning daily", type: "context" },
            { memory: "The user is a nurse in the city hospital on the night shift every weekend", type: "identity" },
        ]);
        const rows = await memories();

        expect(result).toStrictEqual({ added: 1, alreadyKnown: 1, updated: 0 });
        const cyclingRow = await rowOf(cycling);

        expect(cyclingRow?.memory).toBe("The user enjoys cycling along the river every morning");
        expect(rows.find((row: { _id: string }) => row._id === cycling)?.supersededBy).toBeUndefined();
        const nurseRow = await rowOf(nurse);

        expect(nurseRow?.memory).toBe("The user is a nurse in the city hospital on the night shift every week");
    });

    it("confirms a row an earlier merge of the same paste reworded, instead of saving a copy of its old text", async () => {
        expect.assertions(4);

        await setMemoryEnabled(true);

        const berlin = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", {
                    memory: "The user lives in Berlin near the river with a garden and bikes",
                    type: "context",
                    userId: USER,
                }),
        );

        generateText.mockResolvedValueOnce({
            output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" },
        });

        const result = await save([
            { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context" },
            { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
        ]);
        const rows = await memories();

        expect(result).toStrictEqual({ added: 0, alreadyKnown: 1, updated: 1 });
        expect(rows).toHaveLength(1);
        const berlinRow = await rowOf(berlin);

        expect(berlinRow?.memory).toBe("The user lives in Berlin near the river with a garden and bikes daily");
        expect(berlinRow?.lastConfirmedAt).toBeTypeOf("number");
    });
});

describe("linking a second vector replaces the first", () => {
    it("deletes the vector a row lets go of when a second link replaces it", async () => {
        expect.assertions(3);

        const [memoryId, firstEmbedding, secondEmbedding] = await harness.run(async (ctx: any) => {
            const memory = await ctx.db.insert("memories", { memory: "The user now reads the new text", type: "context", userId: USER });
            const first = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 1") });
            const second = await ctx.db.insert("embeddings_128", { model: "m", table: "memories", userId: USER, vector: vectorOf("item 2") });

            return [memory, String(first), String(second)];
        });

        for (const embeddingId of [firstEmbedding, secondEmbedding]) {
            await harness.action(
                async (ctx: any) =>
                    await ctx.runMutation(internal.memory.functions.linkMemoryEmbeddings, {
                        links: [{ embeddingId, memoryId, text: "The user now reads the new text" }],
                        userId: USER,
                    }),
            );
        }

        const row = await rowOf(memoryId);

        expect(row?.embeddingId).toBe(secondEmbedding);
        expect(await harness.run(async (ctx: any) => await ctx.db.get("embeddings_128", firstEmbedding))).toBeNull();
        expect(await harness.run(async (ctx: any) => await ctx.db.get("embeddings_128", secondEmbedding))).not.toBeNull();
    });
});
