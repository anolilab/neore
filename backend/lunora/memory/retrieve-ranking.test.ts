import { describe, expect, it } from "vitest";

import {
    keywordScoresFor,
    rankMemories,
    SEARCH_MAX_RESULTS,
    SEARCH_MIN_KEYWORD_RELEVANCE,
    SEARCH_MIN_RELEVANCE,
    SEARCH_THRESHOLD,
    selectCandidateWindow,
    topScopedHits,
    VECTOR_TOP_K,
    withVectorHits,
} from "./retrieve-ranking";
import type { RankCandidate } from "./retrieve-ranking";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);

const candidate = (id: string, patch: Partial<RankCandidate> = {}): RankCandidate => {
    return {
        _id: id,
        confidence: 100,
        importance: 100,
        lastConfirmedAt: NOW,
        memory: "unrelated words",
        type: "context",
        ...patch,
    };
};

const rank = (candidates: RankCandidate[], vectorScores: [string, number][] = [], searchText = "zzz") =>
    rankMemories({ candidates, keywordScores: keywordScoresFor(candidates, searchText), now: NOW, vectorScores: new Map(vectorScores) });

/** Cosine scores by id, as the vector search returns them. */
const at = (scores: Record<string, number>): [string, number][] => Object.entries(scores);
const idsOf = (rows: { memoryId: string }[]) => rows.map((m) => m.memoryId).toSorted((a, b) => a.localeCompare(b));

describe("rankMemories", () => {
    it("weighs semantic 0.65, confidence 0.12, importance 0.08 and recency 0.15", () => {
        // A fresh memory with every signal at its maximum scores exactly 1.
        expect(rank([candidate("a")], [["a", 1]])[0]!.score).toBeCloseTo(1, 10);
        // Recency halves every 30 days: 0.65 * 0.5 + 0.12 + 0.08 + 0.15 * 0.5.
        expect(rank([candidate("a", { lastConfirmedAt: NOW - 30 * DAY })], [["a", 0.5]])[0]!.score).toBeCloseTo(0.6, 10);
    });

    it("scores a pinned memory as always fresh, and unset confidence and importance as 70 and 50", () => {
        const [pinned] = rank([candidate("a", { confidence: null, importance: undefined, lastConfirmedAt: NOW - 900 * DAY, pinned: true })], [["a", 0.5]]);

        expect(pinned!.score).toBeCloseTo(0.65 * 0.5 + 0.12 * 0.7 + 0.08 * 0.5 + 0.15, 10);
        expect(pinned!.confidence).toBe(70);
    });

    it("injects a relevant memory however old it is, and one under the score threshold not at all", () => {
        const old = { lastConfirmedAt: NOW - 90 * DAY };

        // A fact at cosine 0.5 last confirmed 90 days ago, with the default signals, is injected.
        expect(rank([candidate("a", { ...old, confidence: 70, importance: 50 })], [["a", 0.5]]).map((m) => m.memoryId)).toEqual(["a"]);
        // At the relevance floor, a memory with nothing else going for it (no confidence, no importance, years old) scores 0.65 * 0.45.
        expect(rank([candidate("a", { confidence: 0, importance: 0, lastConfirmedAt: NOW - 900 * DAY })], [["a", 0.45]])).toEqual([]);
    });

    it("leaves out a memory with no relevance, however fresh, confident or pinned", () => {
        const fresh = candidate("fresh");
        const pinned = candidate("pinned", { lastConfirmedAt: 0, pinned: true });
        // No vector hit and no shared word: the old floor of 0.4 let both in on confidence, importance and recency alone.
        const rows = rank([fresh, pinned], [], "something else entirely");

        expect(rows).toEqual([]);
        // A cosine under the floor is no relevance either, a fresh pinned row included.
        expect(rank([fresh, pinned], at({ fresh: 0.3, pinned: 0.44 }))).toEqual([]);
        // Relevance counts: the same two rows at 0.5 are injected.
        expect(idsOf(rank([fresh, pinned], at({ fresh: 0.5, pinned: 0.5 })))).toEqual(["fresh", "pinned"]);
    });

    it("asks for a fifth of the search's words of a memory with no vector hit", () => {
        const text = { lastConfirmedAt: NOW, memory: "likes hiking boots" };

        // 1 of 6 words is under the keyword floor of 0.2; 2 of 6 is over it.
        expect(rank([candidate("a", text)], [], "hiking cooking baking painting running swimming")).toEqual([]);
        expect(rank([candidate("a", text)], [], "hiking boots baking painting running swimming").map((m) => m.memoryId)).toEqual(["a"]);
    });

    it("leaves out an old embedded memory a decisive vector search missed, and finds every other one without a hit by its words", () => {
        const text = { memory: "likes hiking boots" };
        const ids = (candidates: RankCandidate[], vectorSearched: boolean) =>
            rankMemories({
                candidates,
                keywordScores: keywordScoresFor(candidates, "hiking boots"),
                now: NOW,
                vectorScores: new Map(),
                vectorSearched,
            })
                .map((m) => m.memoryId)
                .toSorted((a, b) => a.localeCompare(b));
        const old = candidate("old", { ...text, embeddingId: "emb-old", lastConfirmedAt: NOW - 30 * DAY });
        // Written a minute ago: its vector may not be searchable yet.
        const fresh = candidate("fresh", { ...text, embeddingId: "emb-fresh", lastConfirmedAt: NOW - 60_000 });
        const bare = candidate("bare", { ...text, lastConfirmedAt: NOW - 30 * DAY });

        // The search ran and its hits filled the cut: an old embedded row it lacks is not relevant; a new one or one with no vector is found by words.
        expect(ids([old, fresh, bare], true)).toEqual(["bare", "fresh"]);
        // No decisive search (the model was refused, the index or the hit lookup failed, or other bots' rows took the slots): every memory is found by its words.
        expect(ids([old, fresh, bare], false)).toEqual(["bare", "fresh", "old"]);
    });

    it("matches a word through the punctuation around it", () => {
        const rows = [candidate("a", { memory: "Allergic to peanuts, and (tree-nuts)." })];

        expect(keywordScoresFor(rows, "Do I have peanuts?").get("a")).toBeCloseTo(1 / 3, 10);
        expect(rank(rows, [], "peanuts?").map((m) => m.memoryId)).toEqual(["a"]);
    });

    it("uses a vector hit over the keyword score even when the hit is 0, and the keyword score otherwise", () => {
        const text = { lastConfirmedAt: 0, memory: "hiking boots" };

        expect(rank([candidate("a", text)], [["a", 0]], "hiking boots")).toEqual([]);
        expect(rank([candidate("a", text)], [], "hiking boots")[0]!.score).toBeCloseTo(0.65 + 0.2, 10);
    });

    it("keeps the 8 best, best first, and keeps candidate order among equal scores", () => {
        const many = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`));
        const scores: [string, number][] = many.map((m, i) => [m._id, i < 6 ? 0.5 : 1]);

        expect(rank(many, scores).map((m) => m.memoryId)).toEqual(["m6", "m7", "m8", "m9", "m10", "m11", "m0", "m1"]);
    });

    it("returns only the fields of a retrieved memory", () => {
        expect(Object.keys(rank([candidate("a")], [["a", 1]])[0]!).toSorted((a, b) => a.localeCompare(b))).toEqual([
            "category",
            "confidence",
            "memory",
            "memoryId",
            "score",
        ]);
    });
});

describe("selectCandidateWindow", () => {
    const row = (id: string, type: string, creation: number, patch: Record<string, unknown> = {}) => {
        return {
            _creationTime: creation,
            botId: null as string | null,
            id,
            pinned: false,
            type,
            ...patch,
        };
    };

    it("reads each scope newest first whatever the type, up to the limit", () => {
        const rows = [row("a", "activity", 3), row("b", "preference", 1), row("c", "preference", 2), row("d", "identity", 9)];

        expect(selectCandidateWindow(rows, { limit: 3 }).map((r) => r.id)).toEqual(["d", "a", "c"]);
    });

    it("holds a recent activity row of a user with more rows than the window", () => {
        // Past the window's worth of `preference` and `identity` rows, all older: by type the window is full before it reaches `activity`.
        const rows = [...Array.from({ length: 150 }, (_, i) => row(`pref-${i}`, i % 2 === 0 ? "preference" : "identity", i)), row("trip", "activity", 1000)];

        expect(selectCandidateWindow(rows, { limit: 100 }).map((r) => r.id)).toContain("trip");
        expect(selectCandidateWindow(rows, { limit: 100 })).toHaveLength(100);
    });

    it("leaves out another bot's rows, and an unpinned row past its end date", () => {
        const rows = [
            row("own", "context", 1),
            row("bot", "context", 2, { botId: "bot-a" }),
            row("other", "context", 3, { botId: "bot-b" }),
            row("gone", "context", 4, { validUntil: "2026-11-26" }),
            row("kept", "context", 5, { pinned: true, validUntil: "2026-11-26" }),
            row("today", "context", 6, { validUntil: "2026-11-27" }),
        ];

        expect(selectCandidateWindow(rows, { today: "2026-11-27" }).map((r) => r.id)).toEqual(["today", "kept", "own"]);
        expect(selectCandidateWindow(rows, { botId: "bot-a", includeUserWide: true, today: "2026-11-27" }).map((r) => r.id)).toEqual([
            "today",
            "kept",
            "bot",
            "own",
        ]);
    });
});

describe("withVectorHits", () => {
    const hit = (id: string, patch: Partial<RankCandidate & { botId: string | null; validUntil: string }> = {}) => {
        return { ...candidate(id), botId: null as string | null, ...patch };
    };

    it("adds a hit the window left out, once", () => {
        const window = [hit("a"), hit("b")];

        expect(withVectorHits(window, [hit("b"), hit("old"), hit("old")], {}).map((m) => m._id)).toEqual(["a", "b", "old"]);
    });

    it("never adds a hit on another bot's row, nor on a bot's row in a plain chat", () => {
        const hits = [hit("own"), hit("bot-a", { botId: "bot-a" }), hit("bot-b", { botId: "bot-b" })];

        expect(withVectorHits([], hits, {}).map((m) => m._id)).toEqual(["own"]);
        expect(withVectorHits([], hits, { botId: "bot-a" }).map((m) => m._id)).toEqual(["bot-a"]);
        expect(withVectorHits([], hits, { botId: "bot-a", includeUserWide: true }).map((m) => m._id)).toEqual(["own", "bot-a"]);
    });

    it("leaves out an unpinned fact past its end date", () => {
        const hits = [hit("gone", { validUntil: "2026-11-26" }), hit("kept", { pinned: true, validUntil: "2026-11-26" })];

        expect(withVectorHits([], hits, { today: "2026-11-27" }).map((m) => m._id)).toEqual(["kept"]);
    });
});

describe(topScopedHits, () => {
    it("keeps the best hits of the chat's own scopes, best first, and drops other bots' rows before the cut", () => {
        const other = Array.from({ length: 40 }, (_, i) => {
            return { botId: "bot-b", id: `other-${String(i)}` };
        });
        const own = Array.from({ length: VECTOR_TOP_K + 5 }, (_, i) => {
            return { botId: null, id: `own-${String(i)}` };
        });
        const kept = topScopedHits([...other, ...own], {});

        expect(kept).toHaveLength(VECTOR_TOP_K);
        expect(kept[0]!.id).toBe("own-0");
        expect(topScopedHits([...other, ...own], { botId: "bot-b" }).map((h) => h.id)).toEqual(other.slice(0, VECTOR_TOP_K).map((h) => h.id));
    });
});

describe("search ranking", () => {
    const search = (candidates: RankCandidate[], vectorScores: [string, number][], limit: number) =>
        rankMemories({
            candidates,
            keywordScores: keywordScoresFor(candidates, "zzz"),
            limit,
            minKeywordRelevance: SEARCH_MIN_KEYWORD_RELEVANCE,
            minRelevance: SEARCH_MIN_RELEVANCE,
            now: NOW,
            threshold: SEARCH_THRESHOLD,
            vectorScores: new Map(vectorScores),
        });

    it("returns memories below the injection floor, which injection leaves out", () => {
        const old = candidate("old", { confidence: 0, importance: 0, lastConfirmedAt: NOW - 900 * DAY });
        const loose = candidate("loose");

        // Cosine 0.4 is relevant enough to search and not to inject; the old row at the floor, with nothing else
        // going for it, is under the injection's score threshold and passes only the search.
        expect(rank([old, loose], at({ loose: 0.4, old: 0.45 }))).toEqual([]);
        expect(idsOf(search([old, loose], at({ loose: 0.4, old: 0.45 }), 10))).toEqual(["loose", "old"]);
    });

    it("keeps a floor of its own: a memory with no relevance is not found", () => {
        expect(search([candidate("a"), candidate("b", { pinned: true })], at({ a: 0.1 }), 10)).toEqual([]);
    });

    it("returns up to its own limit, past the 8 injected", () => {
        const many = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`));
        const scores: [string, number][] = many.map((m) => [m._id, 0.9]);

        expect(rank(many, scores)).toHaveLength(8);
        expect(search(many, scores, SEARCH_MAX_RESULTS)).toHaveLength(10);
        expect(search(many, scores, 3)).toHaveLength(3);
    });
});
