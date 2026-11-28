/**
 * Offline retrieval eval: every labelled query runs through the production candidate window and `rankMemories`, with
 * the embedding model replaced by the fixture's deterministic topic vectors (`__fixtures__/README.md`). The floors
 * below are the current numbers; a change to retrieval that lowers one of them has to say why in its own pull request.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    CANDIDATE_WINDOW_SIZE,
    fuseSearchHits,
    isUsableOn,
    KEYWORD_LOOKUP_LIMIT,
    keywordLookupOf,
    keywordLookupTerms,
    lookupSearchesOf,
    keywordSignalsFor,
    rankMemories,
    selectCandidateWindow,
    topKeywordHits,
    topScopedHits,
    VECTOR_FETCH_K,
    vectorCutIsFull,
    withSearchHits,
} from "./retrieve-ranking";
import type { RankedMemory } from "./retrieve-ranking";
import { searchTokensOf } from "./search-terms";
import { timeWindowOf } from "./time-window";

const DAY_MS = 86_400_000;

type Tags = Record<string, number>;

interface FixtureMemory {
    ageDays: number;
    botId?: string;
    confidence: number;
    createdDays: number;
    eventStart?: string;
    id: string;
    importance: number;
    noVector?: boolean;
    pinned?: boolean;
    supersededBy?: string;
    tags: Tags;
    text: string;
    type: string;
    validUntil?: string;
}

interface FixtureQuery {
    asBot?: string;
    category: Category;
    expected: string[];
    id: string;
    persona: string;
    tags: Tags;
    text: string;
    /** The time a `dated` question asks about, as the generator wrote it (never read from the parser). */
    window?: { end: string; start: string };
}

interface Fixture {
    meta: { dimensions: number; now: number; today: string };
    personas: { botId: string; id: string; memories: FixtureMemory[]; userId: string }[];
    queries: FixtureQuery[];
}

type Category = "abstain" | "dated" | "exact" | "multi" | "single" | "temporal" | "update";
/** A category, or `datedAbstain`: the sixth persona's questions that name a time but ask about something nobody mentioned. */
type Slice = Category | "datedAbstain";
const CATEGORIES: Category[] = ["single", "multi", "temporal", "update", "exact", "abstain", "dated"];
const SLICES: Slice[] = [...CATEGORIES, "datedAbstain"];
/** The 180 queries of the first five personas; the sixth's (`dated`, `datedAbstain`) are reported on their own, never in `overall`. */
const isOverall = (query: FixtureQuery): boolean => query.persona !== "p6";
const sliceOf = (query: FixtureQuery): Slice => (query.persona === "p6" && query.category === "abstain" ? "datedAbstain" : query.category);

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/retrieval-eval.json"), "utf8")) as Fixture;
const { now, today } = fixture.meta;

const unitVector = (tags: Tags): number[] => {
    const vector = Array.from({ length: fixture.meta.dimensions }, (_, dimension) => tags[dimension] ?? 0);
    const norm = Math.hypot(...vector);

    return vector.map((x) => x / norm);
};

const cosine = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

/**
 * What the search index answers one search with: every row holding each of its tokens (the last as a prefix), most
 * occurrences first, then newest, cut to what a lookup reads.
 */
const indexSearch = <T extends { _creationTime: number; _id: string; memory: string }>(rows: T[], search: string): T[] => {
    const asked = search.split(" ");
    const occurrences = (tokens: string[], wanted: string, index: number): number =>
        tokens.filter((token) => (index === asked.length - 1 ? token.startsWith(wanted) : token === wanted)).length;

    return rows
        .map((m) => {
            const tokens = searchTokensOf(m.memory);
            const counts = asked.map((wanted, index) => occurrences(tokens, wanted, index));

            return { m, tf: counts.every((count) => count > 0) ? counts.reduce((sum, count) => sum + count, 0) : 0 };
        })
        .filter(({ tf }) => tf > 0)
        .toSorted((a, b) => b.tf - a.tf || b.m._creationTime - a.m._creationTime || (a.m._id < b.m._id ? -1 : 1))
        .slice(0, KEYWORD_LOOKUP_LIMIT)
        .map(({ m }) => m);
};

/**
 * One query as retrieval runs it: the window, the vector hits (top K over all of the user's vectors), the keyword hits
 * (one search-index lookup per salient term), the ranking. Without `vectors` no vector search ran (the model refused,
 * the index failed): the window and the keyword hits, ranked by keyword. Without `time` the asked time is not read.
 */
const run = (query: FixtureQuery, vectors = true, time = true): { ids: string[]; inWindow: Set<string>; ranked: RankedMemory[] } => {
    const persona = fixture.personas.find((p) => p.id === query.persona)!;
    const rows = persona.memories.map((m) => {
        return {
            ...m,
            _creationTime: now - m.createdDays * DAY_MS,
            _id: m.id,
            embeddingId: m.noVector ? undefined : m.id,
            lastConfirmedAt: now - m.ageDays * DAY_MS,
            memory: m.text,
        };
    });
    const queryVector = unitVector(query.tags);

    // The vector index holds every row of the user that has an embedding: other bots', expired and superseded ones too.
    // The lookup then drops a superseded row, so it uses up a hit slot and scores nothing.
    const hits = rows
        .filter((m) => !m.noVector)
        .map((m) => {
            return { cosine: cosine(queryVector, unitVector(m.tags)), id: m.id };
        })
        .toSorted((a, b) => b.cosine - a.cosine || (a.id < b.id ? -1 : 1))
        .slice(0, vectors ? VECTOR_FETCH_K : 0);
    const superseded = new Set(rows.filter((m) => m.supersededBy).map((m) => m.id));
    const scope = { botId: query.asBot, includeUserWide: query.asBot !== undefined };
    const active = rows.filter((m) => !m.supersededBy);
    // The lookup drops a superseded row and an expired one (not pinned), then production keeps the best VECTOR_TOP_K hits of the chat's own scopes.
    const byId = new Map(active.filter((m) => isUsableOn(m, today)).map((m) => [m._id, m]));
    const scoped = topScopedHits(
        hits
            .filter((h) => !superseded.has(h.id) && byId.has(h.id))
            .map((h) => {
                return { botId: byId.get(h.id)!.botId, ...h };
            }),
        scope,
    );
    const vectorScores = new Map(scoped.map((h) => [h.id, h.cosine]));

    const window = selectCandidateWindow(active, { ...scope, limit: CANDIDATE_WINDOW_SIZE, today });

    // The search index, as it answers each term's lookup: every row of the user (other bots', superseded and expired
    // ones too) holding all of the term's tokens (the last as a prefix), most occurrences first, then newest, cut to what
    // a lookup reads; the lookup then keeps the whole-token, usable, in-scope rows (`keywordLookupOf`, as production).
    const lookups = keywordLookupTerms(query.text).map((term) => {
        // What production asks the index for (`lookupSearchesOf`): one search per spelling, each read to the limit.
        const pages = lookupSearchesOf(term).map((search) => indexSearch(rows, search));
        const fetched = [...new Map(pages.flat().map((m) => [m._id, m])).values()];

        return keywordLookupOf(
            term,
            fetched,
            scope,
            today,
            pages.every((page) => page.length < KEYWORD_LOOKUP_LIMIT),
        );
    });

    // Production adds the hits the window lacks (vector hits read by embedding id, best first, fused with the keyword
    // hits), kept only in scope and in effect.
    const candidates = withSearchHits(
        window,
        fuseSearchHits(
            scoped.map((h) => byId.get(h.id)!),
            topKeywordHits(lookups, window.length),
        ),
        { ...scope, today },
    );

    const ranked = rankMemories({
        candidates,
        ...keywordSignalsFor(candidates, query.text, lookups),
        now,
        ...(time && { timeWindow: timeWindowOf(query.text, today) }),
        vectorScores,
        vectorSearched: vectorCutIsFull(scoped),
    });

    return { ids: ranked.map((m) => m.memoryId), inWindow: new Set(candidates.map((m) => m._id)), ranked };
};

interface Totals {
    abstainEmpty: number;
    abstainQueries: number;
    emptyQueries: number;
    injected: number;
    inWindow: number;
    ndcg: number;
    offTopic: number;
    queries: number;
    recall: number;
}

const empty = (): Totals => {
    return { abstainEmpty: 0, abstainQueries: 0, emptyQueries: 0, injected: 0, inWindow: 0, ndcg: 0, offTopic: 0, queries: 0, recall: 0 };
};

const record = (totals: Totals, query: FixtureQuery, ids: string[], inWindow: Set<string>) => {
    const expected = new Set(query.expected);

    totals.injected += ids.length;
    totals.offTopic += ids.filter((id) => !expected.has(id)).length;
    totals.emptyQueries += ids.length === 0 ? 1 : 0;

    if (expected.size === 0) {
        totals.abstainQueries += 1;
        totals.abstainEmpty += ids.length === 0 ? 1 : 0;

        return;
    }

    totals.queries += 1;
    totals.inWindow += query.expected.filter((id) => inWindow.has(id)).length / expected.size;
    totals.recall += ids.filter((id) => expected.has(id)).length / expected.size;

    const gain = ids.reduce((sum, id, rank) => sum + (expected.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
    const ideal = [...expected].reduce((sum, _id, rank) => sum + 1 / Math.log2(rank + 2), 0);

    totals.ndcg += gain / ideal;
};

const summary = (totals: Totals) => {
    return {
        // Of the queries that inject nothing, the share labelled abstain; undefined when every query injects something.
        abstainPrecision: totals.emptyQueries === 0 ? undefined : totals.abstainEmpty / totals.emptyQueries,
        // Share of never-mentioned (abstain-labelled) queries that inject nothing.
        abstainRate: totals.abstainQueries === 0 ? undefined : totals.abstainEmpty / totals.abstainQueries,
        inWindow: totals.queries === 0 ? undefined : totals.inWindow / totals.queries,
        meanInjected: totals.injected / (totals.queries + totals.abstainQueries),
        ndcgAt8: totals.queries === 0 ? undefined : totals.ndcg / totals.queries,
        offTopicRate: totals.injected === 0 ? 0 : totals.offTopic / totals.injected,
        recallAt8: totals.queries === 0 ? undefined : totals.recall / totals.queries,
    };
};

/**
 * The numbers measured with the current retrieval, recorded in `__fixtures__/README.md`. A metric may move by `TOLERANCE`
 * before the test fails (the off-topic rate is a ceiling, the rest are floors). Raise a number after a retrieval
 * improvement; lowering one needs a reason.
 */
const TOLERANCE = 0.02;

interface Floor {
    inWindow?: number;
    ndcgAt8?: number;
    offTopicRate: number;
    recallAt8?: number;
}
const BASELINE: Record<"overall" | Category, Floor> & { overall: Required<Floor> & { abstainPrecision: number; abstainRate: number } } = {
    abstain: { offTopicRate: 1 },
    dated: { inWindow: 1, ndcgAt8: 0.956, offTopicRate: 0.699, recallAt8: 1 },
    exact: { inWindow: 1, ndcgAt8: 1, offTopicRate: 0.048, recallAt8: 1 },
    multi: { inWindow: 1, ndcgAt8: 0.726, offTopicRate: 0.771, recallAt8: 0.883 },
    // Abstain rate 0.933: a bare number is no identifier, so "is parcel 52690 mine" is answered with the user's own
    // parcel note (ends in 77314) instead of nothing.
    overall: { abstainPrecision: 1, abstainRate: 0.933, inWindow: 1, ndcgAt8: 0.853, offTopicRate: 0.836, recallAt8: 0.957 },
    single: { inWindow: 1, ndcgAt8: 0.83, offTopicRate: 0.88, recallAt8: 0.94 },
    // NDCG@8 0.715 before the asked time was read: the month's event now ranks first.
    temporal: { inWindow: 1, ndcgAt8: 1, offTopicRate: 0.872, recallAt8: 1 },
    update: { inWindow: 1, ndcgAt8: 0.776, offTopicRate: 0.873, recallAt8: 1 },
};

describe("memory retrieval eval", () => {
    const overall = empty();
    const byCategory = new Map(SLICES.map((c) => [c, empty()]));

    for (const query of fixture.queries) {
        const { ids, inWindow } = run(query);

        if (isOverall(query)) {
            record(overall, query, ids, inWindow);
        }

        record(byCategory.get(sliceOf(query))!, query, ids, inWindow);
    }

    const results = { overall: summary(overall), ...Object.fromEntries(SLICES.map((c) => [c, summary(byCategory.get(c)!)])) } as Record<
        string,
        ReturnType<typeof summary>
    >;

    it("covers personas past the candidate window, every type and every category", () => {
        expect(fixture.personas).toHaveLength(6);
        expect(fixture.queries.filter((query) => isOverall(query))).toHaveLength(180);

        for (const persona of fixture.personas) {
            const own = persona.memories.filter((m) => !m.botId && !m.supersededBy);

            expect(persona.memories.length).toBeGreaterThanOrEqual(150);
            expect(persona.memories.length).toBeLessThanOrEqual(400);
            expect(own.length).toBeGreaterThan(CANDIDATE_WINDOW_SIZE);
            expect(new Set(persona.memories.map((m) => m.type))).toEqual(new Set(["activity", "context", "experience", "identity", "preference"]));
            expect(persona.memories.some((m) => m.pinned)).toBe(true);
            expect(persona.memories.some((m) => m.supersededBy)).toBe(true);
            expect(persona.memories.some((m) => m.validUntil && m.validUntil < today)).toBe(true);
            expect(persona.memories.some((m) => m.eventStart)).toBe(true);
            expect(new Set(persona.memories.map((m) => m.botId).filter(Boolean))).toEqual(new Set(["bot-a", "bot-b"]));
        }

        const ids = new Set(fixture.personas.flatMap((p) => p.memories.map((m) => m.id)));

        expect(ids.size).toBe(fixture.personas.reduce((n, p) => n + p.memories.length, 0));

        for (const category of CATEGORIES) {
            expect(fixture.queries.filter((q) => q.category === category).length).toBeGreaterThanOrEqual(20);
        }

        for (const persona of fixture.personas) {
            for (const m of persona.memories) {
                // created <= last confirmed <= today (ages count back from `now`)
                expect(m.ageDays >= 0 && m.createdDays >= m.ageDays, `${m.id} created before it was last confirmed, and not in the future`).toBe(true);
            }
        }

        const eventStarts = new Map(fixture.personas.flatMap((p) => p.memories.map((m) => [m.id, m.eventStart] as const)));

        for (const query of fixture.queries) {
            // A past-tense question is only ever answered by an event that has happened.
            if (query.category === "temporal") {
                for (const id of query.expected) {
                    expect(eventStarts.get(id)! <= today, `${query.id} expects ${id}, an event after ${today}`).toBe(true);
                }
            }

            expect(query.expected.every((id) => ids.has(id))).toBe(true);
            expect(query.expected.length === 0).toBe(query.category === "abstain");
        }
    });

    it("holds the baseline", () => {
        const { overall: all, ...categories } = BASELINE;
        const pct = (x: number | undefined) => (x === undefined ? "-" : x.toFixed(3));

        // eslint-disable-next-line no-console
        console.table(
            Object.fromEntries(
                Object.entries(results).map(([name, s]) => [
                    name,
                    {
                        "abstain precision": pct(s.abstainPrecision),
                        "abstain rate": pct(s.abstainRate),
                        "expected in window": pct(s.inWindow),
                        "mean injected": s.meanInjected.toFixed(2),
                        "NDCG@8": pct(s.ndcgAt8),
                        "off-topic rate": pct(s.offTopicRate),
                        "Recall@8": pct(s.recallAt8),
                    },
                ]),
            ),
        );

        expect(results.overall!.recallAt8!).toBeGreaterThanOrEqual(all.recallAt8 - TOLERANCE);
        expect(results.overall!.ndcgAt8!).toBeGreaterThanOrEqual(all.ndcgAt8 - TOLERANCE);
        expect(results.overall!.abstainRate!).toBeGreaterThanOrEqual(all.abstainRate - TOLERANCE);
        expect(results.overall!.abstainPrecision!).toBeGreaterThanOrEqual(all.abstainPrecision - TOLERANCE);
        expect(results.overall!.inWindow!).toBeGreaterThanOrEqual(all.inWindow - TOLERANCE);
        expect(results.overall!.offTopicRate).toBeLessThanOrEqual(all.offTopicRate + TOLERANCE);

        for (const [category, floor] of Object.entries(categories)) {
            const got = results[category]!;

            expect(got.offTopicRate, `${category} off-topic rate`).toBeLessThanOrEqual(floor.offTopicRate + TOLERANCE);

            if (floor.recallAt8 !== undefined) {
                expect(got.recallAt8!, `${category} Recall@8`).toBeGreaterThanOrEqual(floor.recallAt8 - TOLERANCE);
                expect(got.ndcgAt8!, `${category} NDCG@8`).toBeGreaterThanOrEqual(floor.ndcgAt8! - TOLERANCE);
                expect(got.inWindow!, `${category} expected in window`).toBeGreaterThanOrEqual(floor.inWindow! - TOLERANCE);
            }
        }
    });

    it("reads the asked time: dated and temporal questions gain, a question naming no time ranks as without it", () => {
        const without = new Map(SLICES.map((c) => [c, empty()]));
        const overallWithout = empty();
        const named: string[] = [];

        for (const query of fixture.queries) {
            const off = run(query, true, false);
            const window = timeWindowOf(query.text, today);

            record(without.get(sliceOf(query))!, query, off.ids, off.inWindow);

            if (isOverall(query)) {
                record(overallWithout, query, off.ids, off.inWindow);
            }

            // A question naming a time and a topic nobody mentioned that abstained without the step still abstains.
            if (sliceOf(query) === "datedAbstain" && off.ids.length === 0) {
                expect(run(query).ids, query.text).toEqual([]);
            }

            if (window === undefined) {
                expect(run(query).ranked, query.id).toEqual(off.ranked);
            } else if (isOverall(query)) {
                named.push(query.text);
            }

            // Each month a temporal question names is the one its event is in; each dated question reads the generator's window.
            if (query.category === "temporal") {
                const eventStart = fixture.personas.flatMap((p) => p.memories).find((m) => m.id === query.expected[0])!.eventStart!;

                expect(window && eventStart >= window.start && eventStart <= window.end, query.id).toBe(true);
            }

            if (query.window) {
                expect({ end: window?.end, start: window?.start }, query.text).toEqual(query.window);
            }
        }

        const before = { overall: summary(overallWithout), ...Object.fromEntries(SLICES.map((c) => [c, summary(without.get(c)!)])) } as Record<
            string,
            ReturnType<typeof summary>
        >;

        // eslint-disable-next-line no-console
        console.table(
            Object.fromEntries(
                ["overall", ...SLICES].map((c) => [
                    c,
                    {
                        "abstain rate": `${before[c]!.abstainRate?.toFixed(3) ?? "-"} → ${results[c]!.abstainRate?.toFixed(3) ?? "-"}`,
                        "NDCG@8": `${before[c]!.ndcgAt8?.toFixed(3) ?? "-"} → ${results[c]!.ndcgAt8?.toFixed(3) ?? "-"}`,
                        "off-topic rate": `${before[c]!.offTopicRate.toFixed(3)} → ${results[c]!.offTopicRate.toFixed(3)}`,
                        "Recall@8": `${before[c]!.recallAt8?.toFixed(3) ?? "-"} → ${results[c]!.recallAt8?.toFixed(3) ?? "-"}`,
                    },
                ]),
            ),
        );
        // A question naming no time is ranked as without the step (above); of the first 180, only these name one.
        expect(named.filter((text) => fixture.queries.every((q) => q.text !== text || q.category !== "temporal"))).toEqual([
            "which instrument do I play and also what did I rehearse today",
            "what did I rehearse today",
        ]);
        expect(named).toHaveLength(32);
        // Measured 0.687 → 1.000 and 0.589 → 0.956 on this fixture. The `dated` floors gate the numbers; here the step
        // only has to do no worse than the run without it, so a better run without it never fails the eval.
        expect(results.dated!.recallAt8!).toBeGreaterThanOrEqual(before.dated!.recallAt8!);
        expect(results.dated!.ndcgAt8!).toBeGreaterThanOrEqual(before.dated!.ndcgAt8!);
    });

    it("still finds a memory by its words when no vector search ran", () => {
        const totals = empty();

        for (const query of fixture.queries) {
            if (!isOverall(query)) {
                continue;
            }

            const { ids, inWindow } = run(query, false);

            record(totals, query, ids, inWindow);
        }

        const { abstainRate, recallAt8 } = summary(totals);

        // The keyword search still runs. Before it, with word overlap over the window alone: Recall@8 0.160, abstain rate 0.433.
        expect(recallAt8!).toBeGreaterThanOrEqual(0.603 - TOLERANCE);
        // 0.667: an identifier the memory lacks weighs in the share instead of zeroing it, so three questions naming a code
        // nobody has get the sibling code's row through two or more shared words (`QZ-5508` → part, dishwasher;
        // `WTU-40126` → serial, bike; `HIST-318` → evening, course, up). With vectors, all three still abstain.
        expect(abstainRate!).toBeGreaterThanOrEqual(0.667 - TOLERANCE);
    });
});
