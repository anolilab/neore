/**
 * The retrieval action, end to end over the test database: the candidates are the newest rows plus the vector
 * hits outside them (in scope only), a row with no relevance is not injected, and `search_memory`'s search finds
 * more than the injection does.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError, v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import { ACTIVE_READ_MAX_ROWS } from "./functions";
import { retrieveRelevantMemories } from "./retrieve";
import { CANDIDATE_WINDOW_SIZE, SEARCH_MAX_RESULTS, VECTOR_FETCH_K, VECTOR_TOP_K } from "./retrieve-ranking";

const { embedMany, registry, searchVectors } = vi.hoisted(() => {
    return { embedMany: vi.fn(), registry: new Map<string, unknown>(), searchVectors: vi.fn() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
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
    return {
        createGatewayEmbeddingModel: () => {
            return {};
        },
        embeddingModelAllowed: () => true,
    };
});

const USER = "user-a";
/** The search's embedding: any 128-dimension vector, since the vector index is replaced. */
const QUERY_VECTOR = Array.from({ length: 128 }, (_, axis) => (axis === 0 ? 1 : 0));

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    embedMany.mockResolvedValue({ embeddings: [QUERY_VECTOR] });
    searchVectors.mockResolvedValue([]);
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
    });
});

afterEach(() => {
    harness.close();
    vi.resetAllMocks();
});

interface Seed {
    botId?: string;
    embeddingId?: string;
    eventStart?: string;
    lastConfirmedAt?: number;
    memory: string;
    pinned?: boolean;
    type?: "activity" | "context" | "identity" | "preference";
    validUntil?: string;
}

const seed = async (rows: Seed[]): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (const row of rows) {
            await ctx.db.insert("memories", {
                lastConfirmedAt: Date.now(),
                source: "auto",
                type: "preference",
                updatedAt: Date.now(),
                userId: USER,
                ...row,
            });
        }
    });
};

/** The vector index answers with these embedding ids and cosine scores, best first, at most the `limit` asked for. */
const hits = (...found: [string, number][]) =>
    searchVectors.mockImplementation(async (_context: unknown, _vector: unknown, args: { limit: number }) =>
        found.slice(0, args.limit).map(([id, score]) => {
            return { _id: id, _score: score };
        }),
    );

const retrieve = async (args: { botId?: string; limit?: number; search?: boolean; searchText?: string; timeZone?: string | null } = {}): Promise<string[]> => {
    const rows = (await harness.action(
        async (ctx: any) => await ctx.runAction(retrieveRelevantMemories, { searchText: "what did I do on my trip", userId: USER, ...args }),
    )) as { memory: string }[];

    return rows.map((row) => row.memory);
};

/** More rows than the window holds, all newer than whatever is seeded before them and unrelated to any search. */
const filler = (count: number): Seed[] =>
    Array.from({ length: count }, (_, i) => {
        return { memory: `unrelated filler ${String(i)}`, type: i % 2 === 0 ? "preference" : "identity" };
    });

describe("candidates", () => {
    it("injects a relevant activity row of a user with more rows than the window", async () => {
        await seed([{ embeddingId: "emb-trip", memory: "went to the coast in May", type: "activity" }, ...filler(CANDIDATE_WINDOW_SIZE + 20)]);
        hits(["emb-trip", 0.9]);

        // The row is not among the newest 100 and sorts last by type; the vector hit still makes it a candidate.
        expect(await retrieve()).toEqual(["went to the coast in May"]);
    });

    it("does not inject an unrelated recent or pinned row", async () => {
        await seed([{ memory: "likes tea" }, { memory: "always answers in German", pinned: true, type: "identity" }]);

        expect(await retrieve({ searchText: "plan my week" })).toEqual([]);
    });

    it("never adds a hit on another bot's row, in a plain chat or as another bot", async () => {
        await seed([
            { memory: "likes tea" },
            { botId: "bot-a", embeddingId: "emb-a", memory: "bot a secret" },
            { botId: "bot-b", embeddingId: "emb-b", memory: "bot b secret" },
            ...filler(CANDIDATE_WINDOW_SIZE + 5),
        ]);
        hits(["emb-b", 0.95], ["emb-a", 0.9]);

        expect(await retrieve()).toEqual([]);
        expect(await retrieve({ botId: "bot-a" })).toEqual(["bot a secret"]);
    });

    it("searches the vectors when the window is empty", async () => {
        // One live fact behind more expired rows than the read budget holds: the window is empty, and only the hit reaches it.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", {
                embeddingId: "emb-bees",
                lastConfirmedAt: 0,
                memory: "keeps bees",
                source: "auto",
                type: "activity",
                updatedAt: 0,
                userId: USER,
            });

            for (let i = 0; i < ACTIVE_READ_MAX_ROWS; i += 1) {
                await ctx.db.insert("memories", {
                    lastConfirmedAt: 0,
                    memory: `was in Lisbon, trip ${String(i)}`,
                    source: "auto",
                    type: "activity",
                    updatedAt: 0,
                    userId: USER,
                    validUntil: "2020-01-01",
                });
            }
        });
        hits(["emb-bees", 0.9]);

        expect(await retrieve({ searchText: "do I keep bees" })).toEqual(["keeps bees"]);
        expect(searchVectors).toHaveBeenCalledTimes(1);
    });

    it("finds an in-scope memory outside the window when other bots' hits fill the top 30", async () => {
        const others = Array.from({ length: 40 }, (_, i) => {
            return { botId: "bot-b", embeddingId: `emb-b-${String(i)}`, memory: `bot b fact ${String(i)}` };
        });

        await seed([{ embeddingId: "emb-trip", memory: "went to the coast in May", type: "activity" }, ...others, ...filler(CANDIDATE_WINDOW_SIZE + 5)]);
        // Forty of another bot's rows are nearer than the row: past an index top 30, within what is asked for.
        hits(...others.map((row, i): [string, number] => [row.embeddingId, 0.99 - i / 1000]), ["emb-trip", 0.9]);

        expect(await retrieve()).toEqual(["went to the coast in May"]);
        expect(searchVectors).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ limit: VECTOR_FETCH_K }));
    });

    it("finds an old embedded memory by its words when the hit lookup throws", async () => {
        await seed([{ embeddingId: "emb-peanuts", lastConfirmedAt: 0, memory: "allergic to peanuts" }]);
        hits(["emb-peanuts", 0.9]);

        const real = registry.get("memory_functions:getMemoriesByEmbeddingIds");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        registry.set(
            "memory_functions:getMemoriesByEmbeddingIds",
            internalQuery.input({ activeOn: v.optional(v.number()), embeddingIds: v.array(v.string()), userId: v.string() }).query(async () => {
                throw new Error("lookup failed");
            }),
        );

        try {
            // The search answered but the lookup did not: no hit decided anything, so the memory is found by its words as with no search.
            expect(await retrieve({ searchText: "peanuts?" })).toEqual(["allergic to peanuts"]);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Vector search failed"), expect.anything());
        } finally {
            registry.set("memory_functions:getMemoriesByEmbeddingIds", real);
        }
    });

    it("finds a just-written embedded memory the index does not return yet by its words, and leaves out an old one it lacks", async () => {
        // 30 in-scope hits fill the cut (all under the relevance floor), none of them either of the two rows below.
        const near = Array.from({ length: VECTOR_TOP_K }, (_, i) => {
            return { embeddingId: `emb-near-${String(i)}`, memory: `near fact ${String(i)}` };
        });

        await seed([
            ...near,
            { embeddingId: "emb-old", lastConfirmedAt: 0, memory: "adopted a dog named Max" },
            { embeddingId: "emb-new", memory: "adopted a dog named Rex" },
        ]);
        hits(...near.map((row, i): [string, number] => [row.embeddingId, 0.3 - i / 1000]));

        expect(await retrieve({ searchText: "dog named Rex" })).toEqual(["adopted a dog named Rex"]);
    });

    it("finds an old memory outside the window by a rare word the vector search misses, and when the embedding fails", async () => {
        const part = "ordered replacement part KX-2291 for the dishwasher";

        await seed([{ embeddingId: "emb-part", lastConfirmedAt: 0, memory: part }, ...filler(CANDIDATE_WINDOW_SIZE + 5)]);

        // The index answers nothing near it, and the row is older than the newest 100: only the keyword search reaches it.
        expect(await retrieve({ searchText: "did I already order KX-2291" })).toEqual([part]);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        embedMany.mockRejectedValue(new Error("gateway down"));

        expect(await retrieve({ searchText: "did I already order KX-2291" })).toEqual([part]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Vector search failed"), expect.anything());
    });

    it("finds an identifier beside a two-letter word: a short term loses nothing", async () => {
        const part = "ordered replacement part KX-2291 for the dishwasher";

        await seed([{ embeddingId: "emb-part", lastConfirmedAt: 0, memory: part }, ...filler(CANDIDATE_WINDOW_SIZE + 5)]);

        expect(await retrieve({ searchText: "AI KX-2291" })).toEqual([part]);
    });

    it("finds a memory by a serial longer than the index's 16 search terms", async () => {
        const serial = "A1-01-02-03-04-05-06-07-08-09-10-11-12-13-14-15-16";

        await seed([{ embeddingId: "emb-serial", lastConfirmedAt: 0, memory: `router serial ${serial}` }, ...filler(CANDIDATE_WINDOW_SIZE + 5)]);

        expect(await retrieve({ searchText: `where is ${serial}` })).toEqual([`router serial ${serial}`]);
    });

    it("scores the words of a search past its first 2,000 characters", async () => {
        await seed([{ memory: "descaled the kettle" }]);

        // The embedding reads the first 2,000 characters; the keyword score reads all of it.
        expect(await retrieve({ searchText: `${"the ".repeat(600)}kettle` })).toEqual(["descaled the kettle"]);
    });

    it("never finds by keyword a superseded row, a fact past its end date, or another bot's row", async () => {
        await harness.run(async (ctx: any) => {
            const base = { lastConfirmedAt: 0, source: "auto", type: "preference", updatedAt: 0, userId: USER };
            const newer = await ctx.db.insert("memories", { ...base, memory: "rides a bike" });

            await ctx.db.insert("memories", { ...base, memory: "bike serial WTU-38817, old note", supersededBy: newer });
            await ctx.db.insert("memories", { ...base, memory: "bike serial WTU-38817, lapsed", validUntil: "2020-01-01" });
            await ctx.db.insert("memories", { ...base, botId: "bot-b", memory: "bike serial WTU-38817, bot b" });
        });

        expect(await retrieve({ searchText: "whose serial is WTU-38817" })).toEqual([]);
        expect(await retrieve({ botId: "bot-b", searchText: "whose serial is WTU-38817" })).toEqual(["bike serial WTU-38817, bot b"]);
    });

    it("keeps the vector hits, and logs no warning or error, while the keyword index is still building", async () => {
        await seed([{ embeddingId: "emb-trip", memory: "went to the coast in May", type: "activity" }]);
        hits(["emb-trip", 0.9]);

        const real = registry.get("memory_functions:searchMemoriesByKeyword");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        registry.set(
            "memory_functions:searchMemoriesByKeyword",
            internalQuery
                .input({
                    activeOn: v.optional(v.number()),
                    terms: v.array(v.object({ code: v.boolean(), term: v.string(), tokens: v.array(v.string()) })),
                    userId: v.string(),
                })
                .query(async () => {
                    throw new LunoraError("SEARCH_INDEX_BUILDING", "search index is still backfilling");
                }),
        );

        try {
            expect(await retrieve()).toEqual(["went to the coast in May"]);
            expect(warn).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();
        } finally {
            registry.set("memory_functions:searchMemoriesByKeyword", real);
        }
    });

    it("keeps the vector hits when the keyword search throws", async () => {
        await seed([{ embeddingId: "emb-trip", memory: "went to the coast in May", type: "activity" }]);
        hits(["emb-trip", 0.9]);

        const real = registry.get("memory_functions:searchMemoriesByKeyword");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        registry.set(
            "memory_functions:searchMemoriesByKeyword",
            internalQuery
                .input({
                    activeOn: v.optional(v.number()),
                    terms: v.array(v.object({ code: v.boolean(), term: v.string(), tokens: v.array(v.string()) })),
                    userId: v.string(),
                })
                .query(async () => {
                    throw new Error("index unavailable");
                }),
        );

        try {
            expect(await retrieve()).toEqual(["went to the coast in May"]);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Keyword search failed"), expect.anything());
        } finally {
            registry.set("memory_functions:searchMemoriesByKeyword", real);
        }
    });

    it("leaves out a hit on a fact past its end date", async () => {
        await seed([{ embeddingId: "emb-old", memory: "trip next week", type: "activity", validUntil: "2020-01-01" }, ...filler(CANDIDATE_WINDOW_SIZE + 5)]);
        hits(["emb-old", 0.95]);

        expect(await retrieve()).toEqual([]);
    });
});

describe("the asked time", () => {
    it("reads tomorrow in the run's timezone, else the user's stored one", async () => {
        // 23:30 UTC on the 27th: already the 28th in Berlin.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.UTC(2026, 10, 27, 23, 30));

        try {
            await harness.run(async (ctx: any) => {
                const settings = await ctx.db
                    .query("userSettings")
                    .withIndex("by_userId", (q: any) => q.eq("userId", USER))
                    .unique();

                await ctx.db.patch("userSettings", settings._id, { timezone: "Europe/Berlin" });
            });
            await seed([
                { eventStart: "2026-11-28", memory: "dentist at nine", type: "activity" },
                { eventStart: "2026-11-29", memory: "haircut after work", type: "activity" },
            ]);

            expect(await retrieve({ searchText: "what is coming up tomorrow" })).toEqual(["haircut after work"]);
            expect(await retrieve({ searchText: "what is coming up tomorrow", timeZone: "UTC" })).toEqual(["dentist at nine"]);
            // `null`: the caller read no stored zone, so the stored Berlin one is not read again and the day is UTC's.
            expect(await retrieve({ searchText: "what is coming up tomorrow", timeZone: null })).toEqual(["dentist at nine"]);
            expect(await retrieve({ searchText: "what is coming up soon" })).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("search", () => {
    it("returns a memory below the injection floor, which the injection leaves out", async () => {
        await seed([{ embeddingId: "emb-loose", memory: "keeps a garden" }]);
        hits(["emb-loose", 0.4]);

        expect(await retrieve()).toEqual([]);
        expect(await retrieve({ limit: 5, search: true })).toEqual(["keeps a garden"]);
    });

    it("returns up to its own limit, past the 8 injected", async () => {
        const rows = Array.from({ length: 12 }, (_, i) => {
            return { embeddingId: `emb-${String(i)}`, memory: `fact ${String(i)}` };
        });

        await seed(rows);
        hits(...rows.map((row, i): [string, number] => [row.embeddingId, 0.9 - i / 100]));

        expect(await retrieve()).toHaveLength(8);
        expect(await retrieve({ limit: 10, search: true })).toHaveLength(SEARCH_MAX_RESULTS);
        expect(await retrieve({ limit: 3, search: true })).toHaveLength(3);
    });
});
