/**
 * "Forget that": a lookup only finds candidates; every delete waits for the user's confirmation and goes through the one
 * delete path, and nothing outside the chat's own scopes or the rules of a requested memory is ever touched.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { deleteVectorRow } from "../agent/table-writes";
import { internalAction } from "../_generated/server";
import schema from "../schema";
import { extractMemories } from "./extract";
import { reviseExtractedMemory, saveMemoryBatch } from "./functions";
import { rememberFactFor } from "./remember";
import { appWrittenTextPart } from "../chat/lib/attached-text";
import { forgetCandidates, forgetFor } from "./forget";
import { REMEMBER_CALL_MARGIN_MS, REMEMBER_DISPATCH_TTL_MS, rememberDispatchInFlight, withClaimDeadline } from "./remember-dispatch";

const { createGatewayEmbeddingModel, embedMany, generateText, registry, searchVectors } = vi.hoisted(() => {
    return {
        createGatewayEmbeddingModel: vi.fn(() => {
            return {};
        }),
        embedMany: vi.fn(),
        generateText: vi.fn(),
        registry: new Map<string, unknown>(),
        searchVectors: vi.fn(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
        NoAllowedUtilityModelError: class extends Error {},
    };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
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
    return { createGatewayEmbeddingModel, embeddingModelAllowed: () => true };
});
vi.mock("../agent/table-writes", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/table-writes")>();

    return { ...original, deleteVectorRow: vi.fn(original.deleteVectorRow) };
});

const USER = "user-a";
const OTHER = "user-b";
const REPLY = "stream-1";

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "memory_forget", await import("./forget"));
    registerModule(registry, "memory_retrieve", await import("./retrieve"));
    registerModule(registry, "memory_extract", await import("./extract"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
    registerModule(registry, "memory_remember", await import("./remember"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    embedMany.mockResolvedValue({ embeddings: [Array.from({ length: 128 }, (_, axis) => (axis === 0 ? 1 : 0))] });
    searchVectors.mockResolvedValue([]);
});

afterEach(() => {
    harness.close();
    vi.clearAllMocks();
});

type Setup = { content?: unknown; memoryEnabled?: boolean; prompt?: string; thread?: Record<string, unknown>; withBot?: true };

/** The user's chat with their typed prompt and this reply's pending row; the ids the tool passes. */
const setUp = async (setup: Setup = {}) =>
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: setup.memoryEnabled ?? true, timezone: "UTC", userId: USER });

        const botId = setup.withBot
            ? await ctx.db.insert("bots", { computerEnabled: false, instructions: "", model: "m", name: "Chef", userId: USER })
            : undefined;
        const threadId = await ctx.db.insert("threads", { botId, status: "active", tags: ["chat"], userId: USER, ...setup.thread });
        const promptId = await ctx.db.insert("messages", {
            message: { content: setup.content ?? setup.prompt ?? "Forget that I live in Berlin", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: setup.prompt ?? "Forget that I live in Berlin",
            threadId,
            tool: false,
        });

        await ctx.db.insert("messages", { order: 0, status: "pending", stepOrder: 1, threadId, tool: false });

        return { botId: botId as string | undefined, promptMessageId: promptId as string, replyKey: REPLY, threadId, userId: USER };
    });

type Seeded = { embeddingId: string; id: string };

/** A memory with a vector of its own. */
const seed = async (memory: string, extra: Record<string, unknown> = {}): Promise<Seeded> =>
    await harness.run(async (ctx: any) => {
        const userId = (extra.userId as string | undefined) ?? USER;
        const embeddingId = await ctx.db.insert("embeddings_768", {
            model: "m",
            table: "memories",
            userId,
            vector: Array.from({ length: 768 }, (_, index) => index / 768),
        });
        const id = await ctx.db.insert("memories", {
            embeddingId,
            lastConfirmedAt: Date.now(),
            memory,
            source: "auto",
            type: "context",
            userId,
            ...extra,
        });

        return { embeddingId: embeddingId as string, id: id as string };
    });

/** The vector index answers with these memories and cosine scores, best first. */
const hits = (...found: [Seeded, number][]) =>
    searchVectors.mockResolvedValue(
        found.map(([row, score]) => {
            return { _id: row.embeddingId, _score: score };
        }),
    );

const forget = async (source: Awaited<ReturnType<typeof setUp>>, input: { memories?: { id: string; text: string }[]; query?: string }) => {
    const { promptMessageId, replyKey, threadId, userId } = source;

    return await harness.action(async (ctx: any) => await forgetFor(ctx, { promptMessageId, replyKey, threadId, userId, ...input }));
};

const rowOf = async (id: string) => await harness.run(async (ctx: any) => await ctx.db.get("memories", id));
const exists = async (table: string, id: string): Promise<boolean> => (await harness.run(async (ctx: any) => await ctx.db.get(table, id))) !== null;

describe(forgetCandidates, () => {
    it("offers at most five, by relevance alone, so a memory found only by keyword is not pushed out", () => {
        const found = (id: string, relevance: number) => {
            return { memory: id, memoryId: id, relevance };
        };

        // `keyword` holds the query's words but has no vector hit; its keyword share is its relevance.
        const candidates = forgetCandidates([found("a", 0.5), found("b", 0.55), found("c", 0.6), found("d", 0.65), found("e", 0.7), found("keyword", 1)]);

        expect(candidates.map((candidate) => candidate.id)).toStrictEqual(["keyword", "e", "d", "c", "b"]);
    });
});

describe(withClaimDeadline, () => {
    it("measures what is left of the claim when the call starts, less the margin", async () => {
        vi.useFakeTimers();

        const expiresAt = 100_000;
        let signal: AbortSignal | undefined;
        const pending = withClaimDeadline(
            expiresAt,
            async (abortSignal) => {
                signal = abortSignal;

                await new Promise<void>((resolve) => {
                    abortSignal?.addEventListener("abort", () => resolve());
                });

                return "answered";
            },
            () => expiresAt - REMEMBER_CALL_MARGIN_MS - 50,
        );

        await vi.advanceTimersByTimeAsync(49);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        await expect(pending).resolves.toBe("answered");
        await expect(
            withClaimDeadline(
                expiresAt,
                async () => "called",
                () => expiresAt - REMEMBER_CALL_MARGIN_MS,
            ),
        ).resolves.toBeNull();

        vi.useRealTimers();
    });
});

describe(forgetFor, () => {
    it("never deletes on a lookup, even for one perfect match: it hands it back to be confirmed", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        hits([berlin, 0.99]);

        await expect(forget(source, { query: "User lives in Berlin" })).resolves.toStrictEqual({
            candidates: [{ id: berlin.id, text: "User lives in Berlin" }],
            deleted: [],
            status: "needs_confirmation",
        });
        expect(await rowOf(berlin.id)).not.toBeNull();
    });

    it("deletes a confirmed memory through the real delete path: its vector and its older versions go with it", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");
        const older = await seed("User lives in Bonn", { supersededBy: berlin.id });
        const pinned = await seed("User likes tea", { pinned: true });

        await expect(
            forget(source, {
                memories: [
                    { id: berlin.id, text: "User lives in Berlin" },
                    { id: pinned.id, text: "User likes tea" },
                ],
            }),
        ).resolves.toStrictEqual({ deleted: ["User lives in Berlin", "User likes tea"], status: "deleted" });
        expect(await rowOf(berlin.id)).toBeNull();
        expect(await exists("embeddings_768", berlin.embeddingId)).toBe(false);
        expect(await rowOf(older.id)).toBeNull();
        expect(await exists("embeddings_768", older.embeddingId)).toBe(false);
        expect(await rowOf(pinned.id)).toBeNull();
    });

    it("records a vector it could not delete for the cleanup job, as the settings delete does", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("index down"));

        await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toMatchObject({ status: "deleted" });

        const cleanups = await harness.run(async (ctx: any) => await ctx.db.query("memoryCleanups").collect());

        expect(cleanups).toMatchObject([{ embeddingId: berlin.embeddingId, kind: "vector" }]);
    });

    it("counts an id named twice once", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");
        const twice = { id: berlin.id, text: "User lives in Berlin" };

        await expect(forget(source, { memories: [twice, twice] })).resolves.toStrictEqual({ deleted: ["User lives in Berlin"], status: "deleted" });
    });

    it("never offers another user's or another bot's memory, only this chat's scopes", async () => {
        const source = await setUp({ withBot: true });
        const foreign = await seed("User lives in Berlin", { userId: OTHER });
        const otherBot = await seed("User lives in Berlin", { botId: "another-bot" });

        hits([foreign, 0.99], [otherBot, 0.99]);
        await expect(forget(source, { query: "User lives in Berlin" })).resolves.toStrictEqual({ deleted: [], status: "nothing_found" });

        const thisBot = await seed("User cooks vegan", { botId: source.botId });

        hits([thisBot, 0.95]);
        await expect(forget(source, { query: "User cooks vegan" })).resolves.toMatchObject({ candidates: [{ id: thisBot.id }], status: "needs_confirmation" });
        expect(await rowOf(foreign.id)).not.toBeNull();
        expect(await rowOf(otherBot.id)).not.toBeNull();
    });

    it("holds the chat's dispatch claim while the search's embedding call is out, and lets it go after", async () => {
        const source = await setUp();
        const inFlight: boolean[] = [];

        embedMany.mockImplementation(async () => {
            inFlight.push(await harness.run(async (ctx: any) => await rememberDispatchInFlight(ctx, source.threadId)));

            return { embeddings: [[1, 0]] };
        });

        await forget(source, { query: "User lives in Berlin" });

        expect(inFlight).toStrictEqual([true]);
        expect(await harness.run(async (ctx: any) => await rememberDispatchInFlight(ctx, source.threadId))).toBe(false);
    });

    it("returns no candidate text when the chat was shared while the search ran", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        hits([berlin, 0.95]);
        embedMany.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: USER, permission: "read", threadId: source.threadId, userId: OTHER });
            });

            return { embeddings: [[1, 0]] };
        });

        await expect(forget(source, { query: "User lives in Berlin" })).resolves.toStrictEqual({ deleted: [], status: "not_private" });
    });

    it("makes no embedding call when the model's setup used up the chat's claim", async () => {
        const source = await setUp();
        // One pinned clock for the claim and for the setup: the claim is taken at `start`, the setup moves time past its life.
        const start = Date.now();
        let clock = start;
        const now = vi.spyOn(Date, "now").mockImplementation(() => clock);

        createGatewayEmbeddingModel.mockImplementationOnce(() => {
            clock = start + REMEMBER_DISPATCH_TTL_MS;

            return {};
        });

        try {
            await forget(source, { query: "User lives in Berlin" });
        } finally {
            now.mockRestore();
        }

        expect(embedMany).not.toHaveBeenCalled();
    });

    it("deletes the confirmed memories only while each is the user's, in scope, and still reads as shown", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");
        const foreign = await seed("User lives in Paris", { userId: OTHER });
        const otherBot = await seed("User lives in Rome", { botId: "another-bot" });
        const reworded = await seed("User lives in Oslo now");
        const unconfirmed = await seed("User lives in Madrid");

        await expect(
            forget(source, {
                memories: [
                    { id: berlin.id, text: "user lives in  Berlin" },
                    { id: foreign.id, text: "User lives in Paris" },
                    { id: otherBot.id, text: "User lives in Rome" },
                    { id: reworded.id, text: "User lives in Oslo" },
                ],
            }),
        ).resolves.toStrictEqual({
            candidates: [{ id: reworded.id, text: "User lives in Oslo now" }],
            changed: 1,
            deleted: ["User lives in Berlin"],
            gone: 2,
            status: "deleted",
        });

        for (const kept of [foreign, otherBot, reworded, unconfirmed]) {
            expect(await rowOf(kept.id)).not.toBeNull();
        }
    });

    it("asks again, deleting nothing, when compression merged the confirmed memory away before the approval", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        hits([berlin, 0.95]);
        await expect(forget(source, { query: "User lives in Berlin" })).resolves.toMatchObject({ candidates: [{ id: berlin.id }] });

        // Compression retires the row into a merged one before the user approves.
        const [merged] = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    compressedFrom: [berlin.id],
                    memories: [
                        {
                            confidence: 80,
                            evidence: undefined,
                            importance: 60,
                            memory: "User lives in Berlin and works there",
                            source: "compressed",
                            supersedes: undefined,
                            type: "context",
                            userId: USER,
                        },
                    ],
                }),
        );

        searchVectors.mockResolvedValue([]);

        await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
            candidates: [{ id: merged, text: "User lives in Berlin and works there" }],
            changed: 1,
            deleted: [],
            status: "needs_confirmation",
        });
        expect(await rowOf(merged)).not.toBeNull();
    });

    it("offers the version now in effect when the confirmed memory was revised before the approval", async () => {
        const source = await setUp();
        const newer = await seed("User lives in Berlin-Mitte");
        const older = await seed("User lives in Berlin", { supersededBy: newer.id });

        await expect(forget(source, { memories: [{ id: older.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
            candidates: [{ id: newer.id, text: "User lives in Berlin-Mitte" }],
            changed: 1,
            deleted: [],
            status: "needs_confirmation",
        });
        expect(await rowOf(newer.id)).not.toBeNull();
    });

    it("keeps what it deleted when the search for a merged memory fails afterwards", async () => {
        const source = await setUp();
        const tea = await seed("User likes tea");
        const merged = await seed("User lives in Berlin");

        // Retired by compression: it points at itself, so only a search finds what replaced it.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });

        const retrieve = registry.get("memory_retrieve:retrieveRelevantMemories");

        registry.delete("memory_retrieve:retrieveRelevantMemories");

        try {
            await expect(
                forget(source, {
                    memories: [
                        { id: tea.id, text: "User likes tea" },
                        { id: merged.id, text: "User lives in Berlin" },
                    ],
                }),
            ).resolves.toStrictEqual({ deleted: ["User likes tea"], status: "deleted", unchecked: 1 });
        } finally {
            registry.set("memory_retrieve:retrieveRelevantMemories", retrieve);
        }

        expect(await rowOf(tea.id)).toBeNull();
    });

    it("returns counts only, with no memory text, when the chat was shared before the follow-up search", async () => {
        const source = await setUp();
        const tea = await seed("User likes tea");
        const merged = await seed("User lives in Berlin");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });
        // The chat is shared while the follow-up search for the merged memory runs.
        embedMany.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: USER, permission: "read", threadId: source.threadId, userId: OTHER });
            });

            return { embeddings: [[1, 0]] };
        });

        const result = await forget(source, {
            memories: [
                { id: tea.id, text: "User likes tea" },
                { id: merged.id, text: "User lives in Berlin" },
            ],
        });

        expect(result).toStrictEqual({ deleted: [], deletedCount: 1, status: "not_private", unchecked: 1 });
        expect(JSON.stringify(result)).not.toContain("tea");
        // The approved delete stands.
        expect(await rowOf(tea.id)).toBeNull();
    });

    it("returns counts only when the chat was shared and then the follow-up search failed", async () => {
        const source = await setUp();
        const tea = await seed("User likes tea");
        const merged = await seed("User lives in Berlin");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });

        const retrieve = registry.get("memory_retrieve:retrieveRelevantMemories");

        // The search shares the chat and then fails, so it never reaches its own privacy recheck.
        registry.set(
            "memory_retrieve:retrieveRelevantMemories",
            internalAction
                .input({
                    botId: v.optional(v.string()),
                    dispatchExpiresAt: v.optional(v.number()),
                    limit: v.optional(v.number()),
                    orderByRelevance: v.optional(v.boolean()),
                    search: v.optional(v.boolean()),
                    searchText: v.string(),
                    userId: v.string(),
                })
                .action(async () => {
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: USER, permission: "read", threadId: source.threadId, userId: OTHER });
                    });

                    throw new Error("index down");
                }),
        );

        try {
            const result = await forget(source, {
                memories: [
                    { id: tea.id, text: "User likes tea" },
                    { id: merged.id, text: "User lives in Berlin" },
                ],
            });

            expect(result).toStrictEqual({ deleted: [], deletedCount: 1, status: "not_private", unchecked: 1 });
        } finally {
            registry.set("memory_retrieve:retrieveRelevantMemories", retrieve);
        }

        expect(await rowOf(tea.id)).toBeNull();
    });

    it("reports a lookup that could not finish, not no match, when the only confirmed memory's search fails", async () => {
        const source = await setUp();
        const merged = await seed("User lives in Berlin");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });

        const retrieve = registry.get("memory_retrieve:retrieveRelevantMemories");

        registry.delete("memory_retrieve:retrieveRelevantMemories");

        try {
            await expect(forget(source, { memories: [{ id: merged.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
                deleted: [],
                status: "unavailable",
                unchecked: 1,
            });
        } finally {
            registry.set("memory_retrieve:retrieveRelevantMemories", retrieve);
        }
    });

    it("counts both ids as changed when a merged one's search finds the version another id already offered", async () => {
        const source = await setUp();
        const newer = await seed("User lives in Berlin-Mitte");
        const revised = await seed("User lives in Berlin", { supersededBy: newer.id });
        const merged = await seed("User lives in Berlin now");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });
        hits([newer, 0.95]);

        await expect(
            forget(source, {
                memories: [
                    { id: revised.id, text: "User lives in Berlin" },
                    { id: merged.id, text: "User lives in Berlin now" },
                ],
            }),
        ).resolves.toStrictEqual({
            candidates: [{ id: newer.id, text: "User lives in Berlin-Mitte" }],
            changed: 2,
            deleted: [],
            status: "needs_confirmation",
        });
    });

    it("counts a merged-away memory as gone, promising no candidate, when the search for it finds nothing", async () => {
        const source = await setUp();
        const merged = await seed("User lives in Berlin");

        // Retired by compression into a row nothing the search finds now holds.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("memories", merged.id, { supersededBy: merged.id });
        });

        await expect(forget(source, { memories: [{ id: merged.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
            deleted: [],
            gone: 1,
            merged: 1,
            status: "nothing_found",
        });
    });

    it("offers a memory edited in place since the lookup back with its current text, and deletes nothing", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin-Mitte");

        await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
            candidates: [{ id: berlin.id, text: "User lives in Berlin-Mitte" }],
            changed: 1,
            deleted: [],
            status: "needs_confirmation",
        });
        expect(await rowOf(berlin.id)).not.toBeNull();
    });

    it("does not delete an id confirmed with two texts when one of them is not what it reads", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        await expect(
            forget(source, {
                memories: [
                    { id: berlin.id, text: "User lives in Berlin" },
                    { id: berlin.id, text: "User lives in Paris" },
                ],
            }),
        ).resolves.toStrictEqual({ candidates: [{ id: berlin.id, text: "User lives in Berlin" }], changed: 1, deleted: [], status: "needs_confirmation" });
        expect(await rowOf(berlin.id)).not.toBeNull();
    });

    it("never offers back a memory the same confirm deletes", async () => {
        const source = await setUp();
        const kept = await seed("User lives in Berlin and works there");
        // Reflection merged this one into the other between the lookup and the approval.
        const absorbed = await seed("User works in Berlin", { supersededBy: kept.id });

        await expect(
            forget(source, {
                memories: [
                    { id: kept.id, text: "User lives in Berlin and works there" },
                    { id: absorbed.id, text: "User works in Berlin" },
                ],
            }),
        ).resolves.toStrictEqual({ deleted: ["User lives in Berlin and works there"], status: "deleted" });
        expect(await rowOf(absorbed.id)).toBeNull();
    });

    it("counts each confirmed id that led to a newer version as changed, though they share one", async () => {
        const source = await setUp();
        const newer = await seed("User lives in Berlin-Mitte");
        const first = await seed("User lives in Berlin", { supersededBy: newer.id });
        const second = await seed("User lives in Mitte", { supersededBy: newer.id });

        await expect(
            forget(source, {
                memories: [
                    { id: first.id, text: "User lives in Berlin" },
                    { id: second.id, text: "User lives in Mitte" },
                ],
            }),
        ).resolves.toStrictEqual({ candidates: [{ id: newer.id, text: "User lives in Berlin-Mitte" }], changed: 2, deleted: [], status: "needs_confirmation" });
    });

    it("deletes at most five memories in one call", async () => {
        const source = await setUp();
        const rows = await Promise.all(["a", "b", "c", "d", "e", "f"].map(async (name) => await seed(`User likes ${name}`)));

        const result = await forget(source, {
            memories: rows.map((row, index) => {
                return { id: row.id, text: `User likes ${"abcdef"[index]}` };
            }),
        });

        expect(result.deleted).toHaveLength(5);
        expect(await rowOf(rows[5]?.id as string)).not.toBeNull();
    });

    it.each([
        ["memory is off", { memoryEnabled: false }, "memory_off"],
        ["the chat is locked", { thread: { lockedAt: 1 } }, "not_private"],
        ["the chat is public", { thread: { isPublic: true } }, "not_private"],
        ["the chat is a messenger conversation", { thread: { messengerConnectionId: "conn-1" } }, "not_private"],
        ["the chat is a sub-agent's", { thread: { tags: ["sub-agent"] } }, "not_private"],
        ["the message carries a privacy marker", { prompt: "Forget that I live in Berlin [private]" }, "private_message"],
        // A task's instructions or a pull request's opener, saved in the person's own chat: the app wrote them.
        ["the message is a prompt the app wrote", { content: [appWrittenTextPart("Forget that I live in Berlin")] }, "not_your_request"],
    ] as const)("deletes nothing when %s", async (_case, setup, status) => {
        const source = await setUp(setup as Setup);
        const berlin = await seed("User lives in Berlin");

        hits([berlin, 0.95]);

        await expect(forget(source, { query: "User lives in Berlin" })).resolves.toStrictEqual({ deleted: [], status });
        await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({ deleted: [], status });
        expect(await rowOf(berlin.id)).not.toBeNull();
        expect(embedMany).not.toHaveBeenCalled();
    });

    it("deletes nothing for a prompt another run answered", async () => {
        const source = await setUp();
        const berlin = await seed("User lives in Berlin");

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("messages", { order: 0, replyId: "stream-0", status: "success", stepOrder: 2, threadId: source.threadId, tool: false });
        });

        await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toStrictEqual({
            deleted: [],
            status: "not_your_request",
        });
    });

    describe("the reply's own extraction", () => {
        const PROMPT = "Forget that I live in Berlin";

        /** The job the reply schedules for its prompt once it pauses or ends (`afterRun`), and an extractor that finds the fact. */
        const extractTurn = async (source: Awaited<ReturnType<typeof setUp>>) => {
            generateText.mockResolvedValue({
                output: { facts: [{ confidence: 90, importance: 70, memory: "User lives in Berlin", quote: "I live in Berlin", type: "context" }] },
            });

            await harness.action(
                async (ctx: any) =>
                    await ctx.runAction(extractMemories, {
                        assistantResponse: "Done, I forgot it.",
                        promptAt: 1,
                        promptMessageId: source.promptMessageId,
                        quotablePrompt: PROMPT,
                        threadId: source.threadId,
                        userId: USER,
                        userMessage: PROMPT,
                    }),
            );

            const rows: { memory: string }[] = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

            return rows.map((row) => row.memory);
        };

        it("learns from the prompt as usual when no forget ran for it", async () => {
            await expect(extractTurn(await setUp())).resolves.toContain("User lives in Berlin");
        });

        it("does not learn it again after the user approved a confirmed forget", async () => {
            const source = await setUp();
            const berlin = await seed("User lives in Berlin");

            // The approval's answer, saved under the prompt outside any run: the continuation that deletes.
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("messages", {
                    message: { content: [{ approvalId: "approval-1", approved: true, type: "tool-approval-response" }], role: "tool" },
                    order: 0,
                    status: "success",
                    stepOrder: 2,
                    threadId: source.threadId,
                    tool: true,
                });
            });

            await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toMatchObject({ status: "deleted" });
            await expect(extractTurn(source)).resolves.toStrictEqual([]);
            expect(generateText).not.toHaveBeenCalled();
        });

        it("reads only steers after a confirm, even when nothing named was still there to delete", async () => {
            const source = await setUp();
            const berlin = await seed("User lives in Berlin");

            await harness.run(async (ctx: any) => {
                await ctx.db.delete("memories", berlin.id);
            });
            await expect(forget(source, { memories: [{ id: berlin.id, text: "User lives in Berlin" }] })).resolves.toMatchObject({
                gone: 1,
                status: "nothing_found",
            });
            await extractTurn(source);
            expect(generateText).not.toHaveBeenCalled();
        });

        it("saves nothing from the prompt when a forget marks it while the extraction is out", async () => {
            const source = await setUp();

            await harness.run(async (ctx: any) => {
                await ctx.db.insert("memories", { lastConfirmedAt: 1, memory: "User likes tea", source: "auto", type: "preference", userId: USER });
            });
            generateText.mockImplementation(async () => {
                // The lookup lands after the extraction read the prompt's state, before its save.
                await forget(source, { query: "User lives in Berlin" });

                return { output: { facts: [{ confidence: 90, importance: 70, memory: "User lives in Berlin", quote: "I live in Berlin", type: "context" }] } };
            });

            await harness.action(
                async (ctx: any) =>
                    await ctx.runAction(extractMemories, {
                        assistantResponse: "Done.",
                        promptAt: 1,
                        promptMessageId: source.promptMessageId,
                        quotablePrompt: PROMPT,
                        threadId: source.threadId,
                        userId: USER,
                        userMessage: PROMPT,
                    }),
            );

            const rows: { memory: string }[] = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

            expect(generateText).toHaveBeenCalledTimes(1);
            expect(rows.map((row) => row.memory)).toStrictEqual(["User likes tea"]);
        });

        it("lets a remember run in a forget message save what was asked, and nothing else from it", async () => {
            const source = await setUp({ prompt: "Forget that I live in Berlin, and remember I'm vegan" });
            const berlin = await seed("User lives in Berlin", { lastConfirmedAt: 1 });

            await forget(source, { query: "User lives in Berlin" });
            generateText.mockResolvedValue({
                output: {
                    facts: [
                        { asked: false, confidence: 90, importance: 70, memory: "User lives in Berlin", quote: "I live in Berlin", type: "context" },
                        { asked: true, confidence: 90, importance: 70, memory: "User is vegan", quote: "I'm vegan", type: "preference" },
                    ],
                },
            });

            await expect(
                harness.action(
                    async (ctx: any) =>
                        await rememberFactFor(ctx, { promptMessageId: source.promptMessageId, replyKey: REPLY, threadId: source.threadId, userId: USER }),
                ),
            ).resolves.toMatchObject({ facts: [{ asked: true, memory: "User is vegan", status: "saved" }], status: "saved" });

            const rows: { lastConfirmedAt: number; memory: string }[] = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

            // The unasked fact confirmed no row and added none; the asked one is saved.
            expect(rows.map((row) => [row.memory, row.lastConfirmedAt === 1])).toStrictEqual([
                ["User lives in Berlin", true],
                ["User is vegan", false],
            ]);
            // Nor does it revise a similar row.
            await expect(
                harness.run(
                    async (ctx: any) =>
                        await ctx.runMutation(reviseExtractedMemory, {
                            base: "User lives in Berlin",
                            confidence: 90,
                            evidence: { messageId: source.promptMessageId, quote: "I live in Berlin" },
                            lastConfirmedAt: 2,
                            memory: "User lives in Berlin with a partner",
                            memoryId: berlin.id,
                            requested: { promptMessageId: source.promptMessageId, replyKey: REPLY, threadId: source.threadId, userId: USER },
                            userId: USER,
                        }),
                ),
            ).resolves.toBe(false);
        });

        it("reads only steers once a lookup ran, while its candidates wait for the user's approval", async () => {
            const source = await setUp();
            const berlin = await seed("User lives in Berlin");
            const work = await seed("User works in Berlin");

            hits([berlin, 0.88], [work, 0.84]);
            await expect(forget(source, { query: "Berlin" })).resolves.toMatchObject({ status: "needs_confirmation" });

            await extractTurn(source);
            expect(generateText).not.toHaveBeenCalled();
        });
    });
});
