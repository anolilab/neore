/**
 * Offline retrieval eval: every labelled query runs through the production candidate window and `rankMemories`, with
 * the embedding model replaced by the fixture's deterministic topic vectors (`__fixtures__/README.md`). The floors
 * below are the current numbers; a change to retrieval that lowers one of them has to say why in its own pull request.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CANDIDATE_WINDOW_SIZE, keywordScoresFor, rankMemories, selectCandidateWindow, VECTOR_TOP_K, withVectorHits } from "./retrieve-ranking";

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
}

interface Fixture {
    meta: { dimensions: number; now: number; today: string };
    personas: { botId: string; id: string; memories: FixtureMemory[]; userId: string }[];
    queries: FixtureQuery[];
}

type Category = "abstain" | "multi" | "single" | "temporal" | "update";
const CATEGORIES: Category[] = ["single", "multi", "temporal", "update", "abstain"];

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/retrieval-eval.json"), "utf8")) as Fixture;
const { now, today } = fixture.meta;

const unitVector = (tags: Tags): number[] => {
    const vector = Array.from({ length: fixture.meta.dimensions }, (_, dimension) => tags[dimension] ?? 0);
    const norm = Math.hypot(...vector);

    return vector.map((x) => x / norm);
};

const cosine = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

/**
 * One query as retrieval runs it: the window, the vector hits (top K over all of the user's vectors), the ranking.
 * Without `vectors` no vector search ran (the model refused, the index failed): the window alone, ranked by keyword.
 */
const run = (query: FixtureQuery, vectors = true): { ids: string[]; inWindow: Set<string> } => {
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
        .slice(0, vectors ? VECTOR_TOP_K : 0);
    const superseded = new Set(rows.filter((m) => m.supersededBy).map((m) => m.id));
    const vectorScores = new Map(hits.filter((h) => !superseded.has(h.id)).map((h) => [h.id, h.cosine]));

    const scope = { botId: query.asBot, includeUserWide: query.asBot !== undefined };
    const active = rows.filter((m) => !m.supersededBy);
    const window = selectCandidateWindow(active, { ...scope, limit: CANDIDATE_WINDOW_SIZE, today });
    // Production adds the hits the window lacks, read by embedding id and kept only in scope and in effect.
    const candidates = withVectorHits(
        window,
        active.filter((m) => vectorScores.has(m._id)),
        { ...scope, today },
    );

    const ranked = rankMemories({ candidates, keywordScores: keywordScoresFor(candidates, query.text), now, vectorScores, vectorSearched: vectors });

    return { ids: ranked.map((m) => m.memoryId), inWindow: new Set(candidates.map((m) => m._id)) };
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
    multi: { inWindow: 1, ndcgAt8: 0.726, offTopicRate: 0.771, recallAt8: 0.883 },
    overall: { abstainPrecision: 1, abstainRate: 0.9, inWindow: 1, ndcgAt8: 0.771, offTopicRate: 0.853, recallAt8: 0.95 },
    single: { inWindow: 1, ndcgAt8: 0.83, offTopicRate: 0.88, recallAt8: 0.94 },
    temporal: { inWindow: 1, ndcgAt8: 0.715, offTopicRate: 0.872, recallAt8: 1 },
    update: { inWindow: 1, ndcgAt8: 0.776, offTopicRate: 0.873, recallAt8: 1 },
};

describe("memory retrieval eval", () => {
    const overall = empty();
    const byCategory = new Map(CATEGORIES.map((c) => [c, empty()]));

    for (const query of fixture.queries) {
        const { ids, inWindow } = run(query);

        record(overall, query, ids, inWindow);
        record(byCategory.get(query.category)!, query, ids, inWindow);
    }

    const results = { overall: summary(overall), ...Object.fromEntries(CATEGORIES.map((c) => [c, summary(byCategory.get(c)!)])) } as Record<
        string,
        ReturnType<typeof summary>
    >;

    it("covers personas past the candidate window, every type and every category", () => {
        expect(fixture.personas).toHaveLength(5);
        expect(fixture.queries).toHaveLength(150);

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

    it("still finds a memory by its words when no vector search ran", () => {
        const totals = empty();

        for (const query of fixture.queries) {
            const { ids, inWindow } = run(query, false);

            record(totals, query, ids, inWindow);
        }

        const { abstainRate, recallAt8 } = summary(totals);

        // Before relevance gated injection: Recall@8 0.165 and an abstain rate of 0. The keyword floor holds the first and moves the second.
        expect(recallAt8!).toBeGreaterThanOrEqual(0.177 - TOLERANCE);
        expect(abstainRate!).toBeGreaterThanOrEqual(0.55 - TOLERANCE);
    });
});
