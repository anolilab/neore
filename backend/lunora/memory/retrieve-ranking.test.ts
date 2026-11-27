import { describe, expect, it } from "vitest";

import { keywordScoresFor, rankMemories, selectCandidateWindow } from "./retrieve-ranking";
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

describe("rankMemories", () => {
    it("weighs semantic 0.45, confidence 0.18, importance 0.12 and recency 0.25", () => {
        // A fresh memory with every signal at its maximum scores exactly 1.
        expect(rank([candidate("a")], [["a", 1]])[0]!.score).toBeCloseTo(1, 10);
        // Recency halves every 30 days: 0.45 * 0 + 0.18 + 0.12 + 0.25 * 0.5.
        expect(rank([candidate("a", { lastConfirmedAt: NOW - 30 * DAY })])[0]!.score).toBeCloseTo(0.425, 10);
    });

    it("scores a pinned memory as always fresh, and unset confidence and importance as 70 and 50", () => {
        const [pinned] = rank([candidate("a", { confidence: null, importance: undefined, lastConfirmedAt: NOW - 900 * DAY, pinned: true })]);

        expect(pinned!.score).toBeCloseTo(0.18 * 0.7 + 0.12 * 0.5 + 0.25, 10);
        expect(pinned!.confidence).toBe(70);
    });

    it("injects at a score of 0.4 and not under it", () => {
        // Aged to zero recency: 0.18 + 0.12 + 0.45 * s reaches 0.4 at s = 0.1/0.45.
        const old = { lastConfirmedAt: 0 };

        expect(rank([candidate("a", old)], [["a", 0.1 / 0.45]]).map((m) => m.memoryId)).toEqual(["a"]);
        expect(rank([candidate("a", old)], [["a", 0.1 / 0.45 - 0.001]])).toEqual([]);
    });

    it("uses a vector hit over the keyword score even when the hit is 0, and the keyword score otherwise", () => {
        const text = { lastConfirmedAt: 0, memory: "hiking boots" };

        expect(rank([candidate("a", text)], [["a", 0]], "hiking boots")).toEqual([]);
        expect(rank([candidate("a", text)], [], "hiking boots")[0]!.score).toBeCloseTo(0.45 + 0.3, 10);
    });

    it("keeps the 8 best, best first, and keeps candidate order among equal scores", () => {
        const many = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`));
        const scores: [string, number][] = many.map((m, i) => [m._id, i < 6 ? 0.5 : 1]);

        expect(rank(many, scores).map((m) => m.memoryId)).toEqual(["m6", "m7", "m8", "m9", "m10", "m11", "m0", "m1"]);
    });

    it("returns only the fields of a retrieved memory", () => {
        expect(Object.keys(rank([candidate("a")])[0]!).toSorted((a, b) => a.localeCompare(b))).toEqual([
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

    it("reads each scope type descending then newest first, up to the limit", () => {
        const rows = [row("a", "activity", 3), row("b", "preference", 1), row("c", "preference", 2), row("d", "identity", 9)];

        expect(selectCandidateWindow(rows, { limit: 3 }).map((r) => r.id)).toEqual(["c", "b", "d"]);
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
