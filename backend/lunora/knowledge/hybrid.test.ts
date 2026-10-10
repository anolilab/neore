/**
 * Hybrid knowledge retrieval — RRF fusion, keyword term extraction and BM25 re-ranking.
 */
import { describe, expect, it } from "vitest";

import type { KeywordTermHits } from "./hybrid";
import { extractKeywordTerms, MAX_KEYWORD_TERMS, reciprocalRankFusion, RRF_K, scoreKeywordCandidates, tokenize } from "./hybrid";

interface Chunk {
    content: string;
    id: string;
}

const chunk = (id: string, content = ""): Chunk => {
    return { content, id };
};
const ids = <T extends { item: Chunk }>(results: T[]): string[] => results.map((r) => r.item.id);
const byId = (c: Chunk): string => c.id;

describe("reciprocalRankFusion", () => {
    it("scores each item as the sum of 1 / (k + rank) over the lists it appears in", () => {
        const fused = reciprocalRankFusion([[chunk("a"), chunk("b")], [chunk("b")]], byId);

        expect(ids(fused)).toStrictEqual(["b", "a"]);
        expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
        expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 1));
    });

    it("dedupes by id across lists, keeping the first list's copy", () => {
        const fromVector = { content: "vector copy", id: "x" };
        const fromKeyword = { content: "keyword copy", id: "x" };
        const fused = reciprocalRankFusion([[fromVector], [fromKeyword]], byId);

        expect(fused).toHaveLength(1);
        expect(fused[0]!.item).toBe(fromVector);
    });

    it("counts a duplicate within one list once, without pushing later items down", () => {
        const fused = reciprocalRankFusion([[chunk("a"), chunk("a"), chunk("b")]], byId);

        expect(ids(fused)).toStrictEqual(["a", "b"]);
        expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 1));
        expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 2));
    });

    it("reproduces the other list's order when one list is empty", () => {
        const list = [chunk("c"), chunk("a"), chunk("b")];

        expect(ids(reciprocalRankFusion([[], list], byId))).toStrictEqual(["c", "a", "b"]);
        expect(ids(reciprocalRankFusion([list, []], byId))).toStrictEqual(["c", "a", "b"]);
        expect(reciprocalRankFusion<Chunk>([[], []], byId)).toStrictEqual([]);
    });

    it("breaks exact score ties deterministically by first appearance", () => {
        // a is #1 in list one, b is #1 in list two: identical scores and best ranks.
        const fused = reciprocalRankFusion([[chunk("a")], [chunk("b")]], byId);

        expect(fused[0]!.score).toBe(fused[1]!.score);
        expect(ids(fused)).toStrictEqual(["a", "b"]);
        expect(ids(reciprocalRankFusion([[chunk("b")], [chunk("a")]], byId))).toStrictEqual(["b", "a"]);
    });

    it("prefers an item found by both legs over one ranked first by a single leg", () => {
        const vector = [chunk("only-vector"), chunk("both")];
        const keyword = [chunk("only-keyword"), chunk("both")];

        expect(ids(reciprocalRankFusion([vector, keyword], byId))[0]).toBe("both");
    });

    it("records the best rank an item reached", () => {
        const fused = reciprocalRankFusion([[chunk("a"), chunk("b"), chunk("c")], [chunk("c")]], byId);

        expect(fused.find((r) => r.item.id === "c")!.bestRank).toBe(1);
    });
});

describe("tokenize", () => {
    it("lowercases, strips diacritics and splits on non-alphanumerics like the search index", () => {
        expect(tokenize("Café-Überblick ERR_CONN_RESET v2.1")).toStrictEqual(["cafe", "uberblick", "err", "conn", "reset", "v2", "1"]);
    });
});

describe("extractKeywordTerms", () => {
    it("drops stopwords and single letters and leads with digit-bearing terms", () => {
        expect(extractKeywordTerms("What does error E4012 mean in the billing service?")).toStrictEqual(["e4012", "billing", "service", "error", "mean"]);
    });

    it("handles German stopwords", () => {
        expect(extractKeywordTerms("Was ist die Kündigungsfrist für den Vertrag?")).toStrictEqual(["kundigungsfrist", "vertrag"]);
    });

    it("dedupes and caps the number of lookups", () => {
        const terms = extractKeywordTerms("alpha alpha bravo charlie delta echo foxtrot golf hotel");

        expect(terms).toHaveLength(MAX_KEYWORD_TERMS);
        expect(new Set(terms).size).toBe(terms.length);
    });

    it("returns nothing for a query made only of stopwords", () => {
        expect(extractKeywordTerms("what is the")).toStrictEqual([]);
    });
});

describe("scoreKeywordCandidates", () => {
    it("ranks the chunk matching a rare term above chunks matching only a common one", () => {
        const common = [chunk("c1", "the service returned an error"), chunk("c2", "error handling overview"), chunk("rare", "error E4012: quota exceeded")];
        const hits: KeywordTermHits<Chunk>[] = [
            { hits: [chunk("rare", "error E4012: quota exceeded")], term: "e4012" },
            { hits: common, term: "error" },
        ];

        const ranked = scoreKeywordCandidates(hits, 100);

        expect(ranked[0]!.candidate.id).toBe("rare");
        expect(ranked).toHaveLength(3);
    });

    it("rewards chunks that match more query terms", () => {
        const both = chunk("both", "invoice number INV-2231 was refunded");
        const one = chunk("one", "an invoice was issued");
        const ranked = scoreKeywordCandidates(
            [
                { hits: [both], term: "2231" },
                { hits: [one, both], term: "invoice" },
            ],
            50,
        );

        expect(ranked.map((r) => r.candidate.id)).toStrictEqual(["both", "one"]);
    });

    it("keeps IDF non-negative when the corpus count is stale", () => {
        const ranked = scoreKeywordCandidates([{ hits: [chunk("a", "x"), chunk("b", "x")], term: "x" }], 0);

        for (const { score } of ranked) {
            expect(score).toBeGreaterThan(0);
        }
    });

    it("returns nothing without hits", () => {
        expect(scoreKeywordCandidates([{ hits: [], term: "x" }], 10)).toStrictEqual([]);
    });
});

describe("hybrid retrieval fixture: exact identifiers", () => {
    // A realistic failure of vector-only retrieval: the query is an opaque ticket
    // id. Its embedding carries almost no meaning, so the vector leg returns the
    // chunks that are generically "about tickets" and the one chunk that
    // literally contains the id is not among its top results at all.
    const corpus = {
        escalation: chunk("escalation", "Escalation policy: tickets unresolved after 48 hours go to tier 2."),
        target: chunk("target", "Ticket ACME-7731: customer reports duplicate charges after the March migration."),
        triage: chunk("triage", "How we triage support tickets: severity, impact, and customer tier."),
        workflow: chunk("workflow", "The ticket lifecycle: new, triaged, in progress, resolved, closed."),
    };
    const query = "ACME-7731";
    const vectorOnly = [corpus.triage, corpus.workflow, corpus.escalation];

    it("vector alone misses the chunk", () => {
        expect(vectorOnly.map((c) => c.id)).not.toContain("target");
    });

    it("hybrid ranks it alongside the vector leg's best hit", () => {
        const terms = extractKeywordTerms(query);

        expect(terms).toStrictEqual(["7731", "acme"]);

        // What the FTS5 index returns per term (prefix match, userId-filtered).
        const termHits: KeywordTermHits<Chunk>[] = terms.map((term) => {
            return { hits: Object.values(corpus).filter((c) => tokenize(c.content).some((t) => t.startsWith(term))), term };
        });
        const keyword = scoreKeywordCandidates(termHits, Object.keys(corpus).length).map((r) => r.candidate);

        expect(keyword.map((c) => c.id)).toStrictEqual(["target"]);

        const fused = reciprocalRankFusion([vectorOnly, keyword], byId);

        // Tied with the vector leg's #1 on score; bestRank and appearance order put
        // the vector hit first, and both make the final top-5.
        expect(
            ids(fused)
                .slice(0, 2)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["target", "triage"]);
        expect(ids(fused).slice(0, 5)).toContain("target");
    });
});
