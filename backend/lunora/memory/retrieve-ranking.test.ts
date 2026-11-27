import { describe, expect, it } from "vitest";

import {
    fuseSearchHits,
    KEYWORD_LOOKUP_LIMIT,
    keywordLookupOf,
    keywordLookupTerms,
    KEYWORD_TOP_K,
    keywordSignalsFor,
    rankMemories,
    SEARCH_MAX_RESULTS,
    SEARCH_MIN_KEYWORD_RELEVANCE,
    SEARCH_MIN_RELEVANCE,
    SEARCH_THRESHOLD,
    selectCandidateWindow,
    topKeywordHits,
    topScopedHits,
    VECTOR_TOP_K,
    withSearchHits,
} from "./retrieve-ranking";
import type { RankCandidate } from "./retrieve-ranking";
import { MAX_SCORED_TERMS, salientTermsOf } from "./search-terms";

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
    rankMemories({ candidates, ...keywordSignalsFor(candidates, searchText), now: NOW, vectorScores: new Map(vectorScores) });

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

    it("counts the share of the search's words the memory holds, not the words it never had", () => {
        const rows = [candidate("a", { memory: "likes hiking boots" }), candidate("b", { memory: "likes cooking" })];
        const { keywordScores } = keywordSignalsFor(rows, "hiking cooking baking painting running swimming");

        // `baking` … `swimming` are in no memory: `hiking` and `cooking` are the whole search, one each.
        expect(keywordScores.get("a")).toBeCloseTo(0.5, 1);
        expect(keywordScores.get("b")).toBeCloseTo(0.5, 1);
        // One identifier among five words the memory never had still scores in full.
        expect(
            keywordSignalsFor([candidate("e", { memory: "Boiler shows E4012" })], "is E4012 anywhere regarding plumbing heating radiators").keywordScores.get(
                "e",
            ),
        ).toBeCloseTo(1, 2);
    });

    it("caps each term's share at its IDF: a short row holding one of three equally rare terms scores about a third", () => {
        const rows = [
            candidate("short", { memory: "kite" }),
            candidate("zep", { memory: "rode a zeppelin over the bay at dusk last summer" }),
            candidate("har", { memory: "walked along the old harbour wall at dawn each day" }),
        ];
        const { keywordScores } = keywordSignalsFor(rows, "kite zeppelin harbour");

        // BM25's length factor would lift the one-word row above a third.
        expect(keywordScores.get("short")).toBeCloseTo(1 / 3, 2);
        expect(keywordScores.get("zep")).toBeLessThanOrEqual(1 / 3);
    });

    it("scores every salient term of the search, past the lookups' six", () => {
        const searchText = "remember everything regarding wonderful holidays somewhere tropical kettle";

        expect(keywordLookupTerms(searchText)).not.toContain("kettle");
        expect(rank([candidate("k", { memory: "descaled the kettle" })], [], searchText).map((m) => m.memoryId)).toEqual(["k"]);
    });

    it("matches the index's own tokens: a CJK pair inside a longer run, a Cyrillic letter with its diaeresis", () => {
        const rows = [
            candidate("cjk", { memory: "北京大学は東京にある" }),
            candidate("ru", { memory: "видел ёжика и ёж" }),
            candidate("e", { memory: "ел еж" }),
        ];

        expect(rank(rows, [], "大学").map((m) => m.memoryId)).toEqual(["cjk"]);
        // `ёж` is its own token, not `еж`.
        expect(rank(rows, [], "ёж").map((m) => m.memoryId)).toEqual(["ru"]);
    });

    it("matches whole tokens only: `time` is not `timer`", () => {
        const rows = [
            candidate("timer", { memory: "runs a timer" }),
            candidate("both", { memory: "time and timer" }),
            candidate("day", { memory: "time and day" }),
        ];
        const { keywordScores } = keywordSignalsFor(rows, "what time");

        expect(keywordScores.has("timer")).toBe(false);
        // `timer` adds nothing to the term frequency of `time`.
        expect(keywordScores.get("both")).toBeCloseTo(keywordScores.get("day")!, 10);
    });

    it("leaves out an old embedded memory a decisive vector search missed, and finds every other one without a hit by its words", () => {
        const text = { memory: "likes hiking boots" };
        const ids = (candidates: RankCandidate[], vectorSearched: boolean) =>
            rankMemories({
                candidates,
                ...keywordSignalsFor(candidates, "hiking boots"),
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

        // `do`, `I` and `have` are stopwords: `peanuts` is the whole search.
        expect(keywordSignalsFor(rows, "Do I have peanuts?").keywordScores.get("a")).toBeCloseTo(1, 10);
        expect(rank(rows, [], "peanuts?").map((m) => m.memoryId)).toEqual(["a"]);
    });

    it("uses a vector hit over the keyword score even when the hit is 0, unless the memory holds a rare term", () => {
        // Three rows hold both words, so neither is rare.
        const rows = ["a", "b", "c"].map((id) => candidate(id, { lastConfirmedAt: 0, memory: "hiking boots" }));

        expect(idsOf(rank(rows, [["a", 0]], "hiking boots"))).toEqual(["b", "c"]);
        expect(rank(rows, [], "hiking boots")[0]!.score).toBeCloseTo(0.65 + 0.2, 10);
    });

    describe("the rare term, by the user's corpus", () => {
        const old = { embeddingId: "emb", lastConfirmedAt: NOW - 30 * DAY };
        /** A lookup that read every row holding the term. */
        const lookup = (term: string, corpusRows: number) => {
            return { complete: true, corpusRows, term };
        };
        /** Ranked with a decisive vector search that lacks every row unless `vectorScores` says otherwise. */
        const ids = (rows: RankCandidate[], searchText: string, lookups: ReturnType<typeof lookup>[], vectorScores: [string, number][] = []) =>
            rankMemories({
                candidates: rows,
                ...keywordSignalsFor(rows, searchText, lookups),
                now: NOW,
                vectorScores: new Map(vectorScores),
                vectorSearched: true,
            }).map((m) => m.memoryId);

        it("finds a memory holding the query's identifier past a decisive vector search or a low cosine", () => {
            const rows = [
                candidate("part", { ...old, memory: "Placed an order for part KX-2291" }),
                ...["k1", "k2", "k3"].map((id) => candidate(id, { ...old, memory: "Placed an order for a kettle" })),
            ];
            const lookups = [lookup("kx 2291", 1), lookup("order", 4)];

            expect(keywordSignalsFor(rows, "did I order KX-2291", lookups).rareTermMatches).toEqual(new Set(["part"]));
            // The kettles share `order`, a word four rows hold: the vector search decides them, and it lacks them.
            expect(ids(rows, "did I order KX-2291", lookups)).toEqual(["part"]);
            expect(ids(rows, "did I order KX-2291", lookups, [["part", 0.2]])).toEqual(["part"]);
        });

        it("weighs an identifier the memory does not hold: one shared word is not enough, two can be", () => {
            // Rows with no vector are found by words, so only the absent code keeps one out.
            const part = candidate("part", { memory: "Placed an order for part KX-2291" });

            expect(keywordSignalsFor([part], "QZ-5508 part", [lookup("qz 5508", 0), lookup("part", 1)]).keywordScores.size).toBe(0);
            expect(rank([part], [], "QZ-5508 part")).toEqual([]);
            // Relevance by vector still counts.
            expect(rank([part], [["part", 0.9]], "QZ-5508 part").map((m) => m.memoryId)).toEqual(["part"]);

            // An everyday code the memory never had does not wipe a row that shares the question's real words.
            const booster = candidate("booster", { memory: "the doctor said the booster can wait until spring" });

            expect(rank([booster], [], "my covid-19 booster, what did the doctor say").map((m) => m.memoryId)).toEqual(["booster"]);
            // The absent code still weighs in the share: lower than the same row for the question without it.
            expect(keywordSignalsFor([booster], "my covid-19 booster, what did the doctor say").keywordScores.get("booster")).toBeLessThan(
                keywordSignalsFor([booster], "my booster, what did the doctor say").keywordScores.get("booster")!,
            );
        });

        it("finds a memory holding the console or the phone number the query names", () => {
            const ps5 = candidate("ps5", { memory: "bought a PS5 with a two year warranty" });
            const phone = candidate("phone", { memory: "the plumber's number is 555-123-4567" });
            const other = candidate("other", { memory: "the plumber's number is 555-123-9999" });

            expect(rank([ps5], [], "is my PS5 still under warranty").map((m) => m.memoryId)).toEqual(["ps5"]);
            expect(rank([phone, other], [], "who has 555-123-4567").map((m) => m.memoryId)).toEqual(["phone"]);
        });

        it("finds the held code of two the query names, as its rare term", () => {
            const ab = candidate("ab", { ...old, memory: "Ordered part AB-5508" });
            const searchText = "did I order QZ-5508 or AB-5508";
            const lookups = [lookup("qz 5508", 0), lookup("ab 5508", 1)];

            expect(keywordSignalsFor([ab], searchText, lookups).rareTermMatches).toEqual(new Set(["ab"]));
            expect(ids([ab], searchText, lookups)).toEqual(["ab"]);
        });

        it("matches an identifier whole: `AB-5508` is not returned for `QZ-5508` when the vectors miss it", () => {
            const ab = candidate("ab", { ...old, memory: "Ordered part AB-5508" });
            const qz = candidate("qz", { ...old, memory: "Ordered part QZ-5508" });
            const searchText = "did I order QZ-5508";

            expect(ids([ab], searchText, [lookup("qz 5508", 0)])).toEqual([]);
            expect(keywordSignalsFor([ab], searchText, [lookup("qz 5508", 0)]).keywordScores.size).toBe(0);
            expect(ids([ab, qz], searchText, [lookup("qz 5508", 1)])).toEqual(["qz"]);
        });

        it("never counts another bot's rows: a word only they hold is not rare and does not lower this chat's share", () => {
            const kite = keywordLookupOf(
                { code: false, term: "kite", tokens: ["kite"] },
                [{ _id: "other", botId: "bot-b", memory: "flew a kite" }],
                {},
                undefined,
            );
            const own = candidate("own", { ...old, memory: "likes Berlin cafes" });
            // `berlin` is held by two rows of this chat; counting the other bot's row, `kite` (one row) would be rarer.
            const lookups = [kite, lookup("berlin", 2)];
            const signals = keywordSignalsFor([own], "kite Berlin", lookups);

            expect(kite).toMatchObject({ corpusRows: 0, hits: [] });
            expect(signals.keywordScores.get("own")).toBeCloseTo(1, 10);
            expect(signals.rareTermMatches).toEqual(new Set(["own"]));
        });

        it("bounds the scoring of a 100 kB search and still finds an identifier near its start", () => {
            const part = candidate("part", { ...old, memory: "Ordered part KX-2291" });
            // Distinct words of letters only, so none reads as an identifier.
            const word = (i: number) => [...i.toString(26)].map((digit) => String.fromCodePoint(97 + Number.parseInt(digit, 26))).join("");
            const searchText = `did I order KX-2291 ${Array.from({ length: 12_000 }, (_, i) => `filler${word(i)}`).join(" ")}`;

            expect(searchText.length).toBeGreaterThan(100_000);
            expect(salientTermsOf(searchText).length).toBeLessThanOrEqual(MAX_SCORED_TERMS);
            expect(ids([part], searchText, [lookup("kx 2291", 1)])).toEqual(["part"]);
        });

        it("reads a plain number as an ordinary term: it never turns keyword relevance off", () => {
            const hotel = candidate("hotel", { lastConfirmedAt: NOW - 30 * DAY, memory: "Liked the hotel by the old harbour" });
            const searchText = "my budget is 15000, which hotel did I like?";

            expect(keywordSignalsFor([hotel], searchText).keywordScores.get("hotel")).toBeGreaterThan(0);
            // No vector hit for it, and no decisive search: it is found by its words.
            expect(rank([hotel], [], searchText).map((m) => m.memoryId)).toEqual(["hotel"]);
        });

        it("reads a year as a word, not an identifier: it does not turn the rule off", () => {
            const rows = [candidate("canon", { ...old, memory: "Canon camera serial KX-2291" }), candidate("other", { ...old, memory: "bought a new desk" })];
            const searchText = "serial of the Canon camera I bought in 2019";
            const lookups = [lookup("serial", 1), lookup("camera", 1), lookup("bought", 1), lookup("canon", 1), lookup("2019", 0)];

            expect(ids(rows, searchText, lookups)).toEqual(["canon"]);
        });

        it("counts a word rare only by the user's own rows, and only with the query's leading term", () => {
            // Several restaurant notes: `restaurant` is not rare however few of them are candidates.
            const restaurants = [
                candidate("r1", { ...old, memory: "likes the restaurant near the office" }),
                candidate("r2", { ...old, memory: "favorite colour is green" }),
            ];

            expect(ids(restaurants, "favorite restaurant in Berlin", [lookup("restaurant", 6), lookup("favorite", 1), lookup("berlin", 0)])).toEqual([]);

            // `E4012` is the rare term: the invoice-only row shares a word and is not a match.
            const boiler = [
                candidate("boiler", { ...old, memory: "Boiler error E4012 on the invoice" }),
                candidate("invoice", { ...old, memory: "Paid the invoice for the plumber" }),
            ];

            expect(ids(boiler, "E4012 invoice", [lookup("e4012", 1), lookup("invoice", 2)])).toEqual(["boiler"]);
            // Without corpus counts (the lookups failed), no term is known to be rare.
            expect(ids(boiler, "E4012 invoice", [])).toEqual([]);
        });
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
            "lastConfirmedAt",
            "memory",
            "memoryId",
            "score",
        ]);
    });

    it("carries a memory's last confirmation as a time, and only the dates it has", () => {
        const dated = candidate("a", { eventEnd: "2026-12-05", eventStart: "2026-12-03", lastConfirmedAt: NOW - DAY, validUntil: "2026-12-31" });

        expect(rank([dated], [["a", 1]])[0]).toMatchObject({
            eventEnd: "2026-12-05",
            eventStart: "2026-12-03",
            lastConfirmedAt: NOW - DAY,
            validUntil: "2026-12-31",
        });
        expect(rank([candidate("a", { eventEnd: null, eventStart: "2026-12-03", validUntil: null })], [["a", 1]])[0]).not.toHaveProperty("validUntil");
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

describe("keyword hits", () => {
    const row = (
        id: string,
        memory: string,
        botId: string | null = null,
    ): { _id: string; botId: string | null; memory: string; supersededBy?: string; validUntil?: string } => {
        return { _id: id, botId, memory };
    };

    it("keeps whole-token, usable, in-scope rows before the cut, so prefix matches cannot crowd them out", () => {
        const fetched = [
            ...Array.from({ length: 30 }, (_, i) => row(`prefix-${String(i)}`, `set a timer ${String(i)}`)),
            { ...row("superseded", "time for tea"), supersededBy: "newer" },
            { ...row("expired", "time for tea"), validUntil: "2026-11-01" },
            row("other", "time for tea", "bot-b"),
            row("own", "time for tea"),
        ];
        const time = { code: false, term: "time", tokens: ["time"] };
        const result = keywordLookupOf(time, fetched, {}, "2026-11-27");

        expect(result.hits.map((h) => h._id)).toEqual(["own"]);
        // Every usable row of the chat's scopes holding the term, the other bot's not; fewer rows than a lookup reads, so all of them.
        expect(result).toMatchObject({ complete: true, corpusRows: 1 });
        expect(
            keywordLookupOf(
                time,
                Array.from({ length: KEYWORD_LOOKUP_LIMIT }, (_, i) => row(`t${String(i)}`, "time")),
                {},
                undefined,
            ).complete,
        ).toBe(false);
    });

    it("keeps a row only when it holds the whole identifier: `AB-5508` is no hit for `QZ-5508`", () => {
        const [code] = keywordLookupTerms("did I order QZ-5508");
        const fetched = [row("ab", "Ordered part AB-5508"), row("apart", "QZ order and 5508 later"), row("qz", "Ordered part QZ-5508")];

        expect(code).toEqual({ code: true, term: "qz 5508", tokens: ["qz", "5508"] });
        expect(keywordLookupOf(code!, fetched, {}, undefined)).toMatchObject({ corpusRows: 1, hits: [{ _id: "qz" }] });
    });

    it("keeps the best hits by BM25", () => {
        const lookups = [
            { code: false, complete: true, corpusRows: 30, hits: [row("own", "ordered KX-2291 for the dishwasher"), row("plain", "KX notes")], term: "kx" },
            { code: true, complete: true, corpusRows: 30, hits: [row("own", "ordered KX-2291 for the dishwasher")], term: "2291" },
        ];

        expect(topKeywordHits(lookups, 0).map((h) => h._id)).toEqual(["own", "plain"]);
        expect(topKeywordHits(lookups, 0, 1).map((h) => h._id)).toEqual(["own"]);
    });

    it("keeps an identifier's rows and each term's first rows ahead of the cut, so short rows cannot push them out", () => {
        const short = Array.from({ length: 40 }, (_, i) => row(`s${String(i)}`, "replacement dishwasher part"));
        const long = row("long", "after a long search the replacement dishwasher part KX-2291 finally arrived by post");
        const lookups = [
            { code: true, complete: true, corpusRows: 1, hits: [long], term: "2291" },
            { code: false, complete: true, corpusRows: 41, hits: short.slice(0, 20), term: "dishwasher" },
            { code: false, complete: true, corpusRows: 41, hits: short.slice(20), term: "replacement" },
        ];
        const kept = topKeywordHits(lookups, 0);

        expect(kept).toHaveLength(KEYWORD_TOP_K);
        expect(kept[0]!._id).toBe("long");
        // The first rows of each other term are kept too, whatever BM25 says of them.
        expect(kept.map((h) => h._id)).toEqual(expect.arrayContaining(["s0", "s1", "s2", "s20", "s21", "s22"]));
    });

    it("fuses the vector and keyword hits by rank: a row both found leads, each row once", () => {
        const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => row(id, id));

        expect(fuseSearchHits([a!, b!, c!], [c!, d!]).map((h) => h._id)).toEqual(["c", "a", "b", "d"]);
        expect(fuseSearchHits([], [d!, a!]).map((h) => h._id)).toEqual(["d", "a"]);
    });
});

describe("withSearchHits", () => {
    const hit = (id: string, patch: Partial<RankCandidate & { botId: string | null; validUntil: string }> = {}) => {
        return { ...candidate(id), botId: null as string | null, ...patch };
    };

    it("adds a hit the window left out, once", () => {
        const window = [hit("a"), hit("b")];

        expect(withSearchHits(window, [hit("b"), hit("old"), hit("old")], {}).map((m) => m._id)).toEqual(["a", "b", "old"]);
    });

    it("never adds a hit on another bot's row, nor on a bot's row in a plain chat", () => {
        const hits = [hit("own"), hit("bot-a", { botId: "bot-a" }), hit("bot-b", { botId: "bot-b" })];

        expect(withSearchHits([], hits, {}).map((m) => m._id)).toEqual(["own"]);
        expect(withSearchHits([], hits, { botId: "bot-a" }).map((m) => m._id)).toEqual(["bot-a"]);
        expect(withSearchHits([], hits, { botId: "bot-a", includeUserWide: true }).map((m) => m._id)).toEqual(["own", "bot-a"]);
    });

    it("leaves out an unpinned fact past its end date", () => {
        const hits = [hit("gone", { validUntil: "2026-11-26" }), hit("kept", { pinned: true, validUntil: "2026-11-26" })];

        expect(withSearchHits([], hits, { today: "2026-11-27" }).map((m) => m._id)).toEqual(["kept"]);
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
            ...keywordSignalsFor(candidates, "zzz"),
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
