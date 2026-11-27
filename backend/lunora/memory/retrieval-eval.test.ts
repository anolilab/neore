/**
 * Offline retrieval eval: every labelled query runs through the production candidate window and `rankMemories`, with
 * the embedding model replaced by the fixture's deterministic topic vectors (`__fixtures__/README.md`). The floors
 * below are the baseline; a change to retrieval that lowers one of them has to say why in its own pull request.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { keywordScoresFor, rankMemories, selectCandidateWindow } from "./retrieve-ranking";

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
    meta: { dimensions: number; now: number; today: string; vectorTopK: number; windowSize: number };
    personas: { botId: string; id: string; memories: FixtureMemory[]; userId: string }[];
    queries: FixtureQuery[];
}

type Category = "abstain" | "multi" | "single" | "temporal" | "update";
const CATEGORIES: Category[] = ["single", "multi", "temporal", "update", "abstain"];

const fixture = JSON.parse(readFileSync(new URL("__fixtures__/retrieval-eval.json", import.meta.url), "utf8")) as Fixture;
const { now, today, vectorTopK, windowSize } = fixture.meta;

const unitVector = (tags: Tags): number[] => {
    const vector = Array.from({ length: fixture.meta.dimensions }, (_, dimension) => tags[dimension] ?? 0);
    const norm = Math.hypot(...vector);

    return vector.map((x) => x / norm);
};

const cosine = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

/** One query as retrieval runs it: the window, the vector hits (top K over all of the user's vectors), the ranking. */
const injected = (query: FixtureQuery): string[] => {
    const persona = fixture.personas.find((p) => p.id === query.persona)!;
    const rows = persona.memories.map((m) => {
        return {
            ...m,
            _creationTime: now - m.createdDays * DAY_MS,
            _id: m.id,
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
        .slice(0, vectorTopK);
    const superseded = new Set(rows.filter((m) => m.supersededBy).map((m) => m.id));
    const vectorScores = new Map(hits.filter((h) => !superseded.has(h.id)).map((h) => [h.id, h.cosine]));

    const candidates = selectCandidateWindow(
        rows.filter((m) => !m.supersededBy),
        { botId: query.asBot, includeUserWide: query.asBot !== undefined, limit: windowSize, today },
    );

    return rankMemories({ candidates, keywordScores: keywordScoresFor(candidates, query.text), now, vectorScores }).map((m) => m.memoryId);
};

interface Totals {
    abstainEmpty: number;
    abstainQueries: number;
    injected: number;
    ndcg: number;
    offTopic: number;
    queries: number;
    recall: number;
}

const empty = (): Totals => {
    return { abstainEmpty: 0, abstainQueries: 0, injected: 0, ndcg: 0, offTopic: 0, queries: 0, recall: 0 };
};

const record = (totals: Totals, query: FixtureQuery, ids: string[]) => {
    const expected = new Set(query.expected);

    totals.injected += ids.length;
    totals.offTopic += ids.filter((id) => !expected.has(id)).length;

    if (expected.size === 0) {
        totals.abstainQueries += 1;
        totals.abstainEmpty += ids.length === 0 ? 1 : 0;

        return;
    }

    totals.queries += 1;
    totals.recall += ids.filter((id) => expected.has(id)).length / expected.size;

    const gain = ids.reduce((sum, id, rank) => sum + (expected.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
    const ideal = [...expected].reduce((sum, _id, rank) => sum + 1 / Math.log2(rank + 2), 0);

    totals.ndcg += gain / ideal;
};

const summary = (totals: Totals) => {
    return {
        abstainPrecision: totals.abstainQueries === 0 ? undefined : totals.abstainEmpty / totals.abstainQueries,
        meanInjected: totals.injected / (totals.queries + totals.abstainQueries),
        ndcgAt8: totals.queries === 0 ? undefined : totals.ndcg / totals.queries,
        offTopicRate: totals.injected === 0 ? 0 : totals.offTopic / totals.injected,
        recallAt8: totals.queries === 0 ? undefined : totals.recall / totals.queries,
    };
};

/**
 * Today's numbers, recorded in `__fixtures__/README.md`. A metric may move by `TOLERANCE` before the test fails (the
 * off-topic rate is a ceiling, the rest are floors). Raise a number after a retrieval improvement; lowering one needs a reason.
 */
const TOLERANCE = 0.02;
const BASELINE = {
    multi: { ndcgAt8: 0.588, recallAt8: 0.767 },
    overall: { abstainPrecision: 0, ndcgAt8: 0.47, offTopicRate: 0.911, recallAt8: 0.646 },
    single: { ndcgAt8: 0.574, recallAt8: 0.8 },
    temporal: { ndcgAt8: 0.067, recallAt8: 0.067 },
    update: { ndcgAt8: 0.636, recallAt8: 0.95 },
};

describe("memory retrieval eval", () => {
    const overall = empty();
    const byCategory = new Map(CATEGORIES.map((c) => [c, empty()]));

    for (const query of fixture.queries) {
        const ids = injected(query);

        record(overall, query, ids);
        record(byCategory.get(query.category)!, query, ids);
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
            expect(own.length).toBeGreaterThan(windowSize);
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

        for (const query of fixture.queries) {
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
        expect(results.overall!.abstainPrecision!).toBeGreaterThanOrEqual(all.abstainPrecision - TOLERANCE);
        expect(results.overall!.offTopicRate).toBeLessThanOrEqual(all.offTopicRate + TOLERANCE);

        for (const [category, floor] of Object.entries(categories)) {
            expect(results[category]!.recallAt8!, `${category} Recall@8`).toBeGreaterThanOrEqual(floor.recallAt8 - TOLERANCE);
            expect(results[category]!.ndcgAt8!, `${category} NDCG@8`).toBeGreaterThanOrEqual(floor.ndcgAt8 - TOLERANCE);
        }
    });
});
