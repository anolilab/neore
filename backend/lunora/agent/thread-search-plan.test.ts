import { describe, expect, it } from "vitest";

import {
    bestMeaningThreadIds,
    countUserTurns,
    decideCommit,
    hasEnoughTurns,
    isSearchEligible,
    planThreadSearch,
    searchKindsChanged,
    searchText,
    type SearchRow,
    type SearchState,
    withoutSearchVectors,
} from "./thread-search-plan";

const thread = (overrides: Partial<SearchRow> = {}): SearchRow => {
    return {
        lastReplyAt: 1,
        title: "PDF totals off by one",
        userId: "user-1",
        ...overrides,
    };
};

const slots = (overrides: Partial<SearchState["slots"]> = {}): SearchState["slots"] => {
    return {
        summary: {},
        title: {},
        ...overrides,
    };
};

describe(searchKindsChanged, () => {
    it("names every kind with text when a thread is inserted", () => {
        expect(searchKindsChanged(undefined, thread({ summary: "Refund flow" }))).toEqual(["title", "summary"]);
    });

    it("names nothing for an insert with no text", () => {
        expect(searchKindsChanged(undefined, { userId: "user-1" })).toEqual([]);
    });

    it("re-embeds only the kind whose text moved", () => {
        expect(searchKindsChanged(thread({ summary: "a" }), thread({ summary: "a" }))).toEqual([]);
        expect(searchKindsChanged(thread({ summary: "a" }), thread({ summary: "b" }))).toEqual(["summary"]);
        expect(searchKindsChanged(thread(), thread({ title: "New name" }))).toEqual(["title"]);
    });

    it("ignores whitespace-only changes to a title", () => {
        expect(searchKindsChanged(thread({ title: "Invoice" }), thread({ title: "Invoice  " }))).toEqual([]);
    });

    it("re-checks both kinds when a thread is locked, so its vectors are removed", () => {
        expect(searchKindsChanged(thread(), thread({ lockedAt: 5 }))).toEqual(["title", "summary"]);
    });

    it("re-checks both kinds when a thread is deleted or restored", () => {
        expect(searchKindsChanged(thread(), thread({ deleted: true }))).toEqual(["title", "summary"]);
    });

    it("names a kind on a reply only while it has no vector, so the turn gate is re-read a bounded number of times", () => {
        expect(searchKindsChanged(thread({ lastReplyAt: 1 }), thread({ lastReplyAt: 2 }))).toEqual(["title"]);
        expect(searchKindsChanged(thread({ lastReplyAt: 1 }), thread({ lastReplyAt: 2, titleVectorId: "v1" }))).toEqual([]);
    });

    it("does not re-check a locked thread on a reply", () => {
        expect(searchKindsChanged(thread({ lastReplyAt: 1, lockedAt: 3 }), thread({ lastReplyAt: 2, lockedAt: 3 }))).toEqual([]);
    });
});

describe(planThreadSearch, () => {
    it("embeds the title of a thread past the turn gate", () => {
        const plan = planThreadSearch({ eligible: true, slots: slots({ title: { text: "PDF totals off by one" } }) }, ["title"], true);

        expect(plan).toEqual({ clear: [], embed: ["title"] });
    });

    it("never embeds a thread with three or fewer user turns", () => {
        const plan = planThreadSearch({ eligible: true, slots: slots({ title: { text: "Short" } }) }, ["title"], false);

        expect(plan).toEqual({ clear: [], embed: [] });
    });

    it("never embeds a locked thread, and removes the vectors it has", () => {
        const plan = planThreadSearch(
            {
                eligible: false,
                slots: slots({ summary: { text: "Refunds", vectorId: "s1" }, title: { text: "Refund", vectorId: "t1" } }),
            },
            ["title", "summary"],
            true,
        );

        expect(plan).toEqual({
            clear: [
                { kind: "title", vectorId: "t1" },
                { kind: "summary", vectorId: "s1" },
            ],
            embed: [],
        });
    });

    it("replaces a moved title: embeds the new text and clears the old vector", () => {
        const plan = planThreadSearch({ eligible: true, slots: slots({ title: { text: "New", vectorId: "old" } }) }, ["title"], true);

        expect(plan).toEqual({ clear: [{ kind: "title", vectorId: "old" }], embed: ["title"] });
    });

    it("keeps a vector whose text did not move", () => {
        const plan = planThreadSearch({ eligible: true, slots: slots({ title: { text: "Same", vectorId: "kept" } }) }, [], true);

        expect(plan).toEqual({ clear: [], embed: [] });
    });

    it("embeds a kind that has text but no vector, even when the write named no kind", () => {
        const plan = planThreadSearch({ eligible: true, slots: slots({ title: { text: "Ready" } }) }, [], true);

        expect(plan.embed).toEqual(["title"]);
    });
});

describe(decideCommit, () => {
    const stored = (overrides: Partial<SearchState["slots"]> = {}): SearchState["slots"] => {
        return { summary: {}, title: {}, ...overrides };
    };

    it("accepts a vector whose text is still the thread's text, and deletes the vector it supersedes", () => {
        const decision = decideCommit(stored({ title: { text: "New", vectorId: "old" } }), [{ kind: "title", text: "New", vectorId: "new" }], []);

        expect(decision.accepted).toEqual(["new"]);
        expect(decision.replaced).toEqual(["old"]);
        expect(decision.set).toEqual({ title: "new" });
    });

    it("refuses a vector whose text moved while it was embedded: a newer write queued its own sync", () => {
        const decision = decideCommit(stored({ title: { text: "Newer" } }), [{ kind: "title", text: "Older", vectorId: "stale" }], []);

        expect(decision.accepted).toEqual([]);
        expect(decision.set).toEqual({});
    });

    it("clears a stored vector only while it is still the one the plan read", () => {
        const cleared = decideCommit(stored({ title: { text: "x", vectorId: "same" } }), [], [{ kind: "title", vectorId: "same" }]);
        const superseded = decideCommit(stored({ title: { text: "x", vectorId: "other" } }), [], [{ kind: "title", vectorId: "same" }]);

        expect(cleared).toEqual({ accepted: [], replaced: ["same"], set: { title: undefined } });
        expect(superseded.replaced).toEqual([]);
        expect(superseded.set).toEqual({});
    });
});

describe("user turns", () => {
    const turn = (role: string) => {
        return { message: { role } };
    };

    it("counts only user rows", () => {
        expect(countUserTurns([turn("user"), turn("assistant"), turn("tool"), turn("user")])).toBe(2);
    });

    it("needs MORE than three user turns: three is not enough, four is", () => {
        expect(hasEnoughTurns(3)).toBe(false);
        expect(hasEnoughTurns(4)).toBe(true);
    });
});

describe("eligibility", () => {
    it("excludes a locked, deleted, temporary or owner-less thread", () => {
        expect(isSearchEligible(thread())).toBe(true);
        expect(isSearchEligible(thread({ lockedAt: 1 }))).toBe(false);
        expect(isSearchEligible(thread({ deleted: true }))).toBe(false);
        expect(isSearchEligible(thread({ isTemporary: true }))).toBe(false);
        expect(isSearchEligible({ title: "x" })).toBe(false);
    });
});

describe(bestMeaningThreadIds, () => {
    it("keeps each thread once, at its best score, best first", () => {
        const ranked = bestMeaningThreadIds(
            [
                { score: 0.6, threadId: "a" },
                { score: 0.9, threadId: "a" },
                { score: 0.7, threadId: "b" },
            ],
            0.5,
            10,
        );

        expect(ranked).toEqual([
            { score: 0.9, threadId: "a" },
            { score: 0.7, threadId: "b" },
        ]);
    });

    it("drops matches below the minimum score and caps the list", () => {
        const ranked = bestMeaningThreadIds(
            [
                { score: 0.2, threadId: "weak" },
                { score: 0.8, threadId: "a" },
                { score: 0.7, threadId: "b" },
            ],
            0.5,
            1,
        );

        expect(ranked).toEqual([{ score: 0.8, threadId: "a" }]);
    });
});

describe("export and text", () => {
    it("strips the vector ids from a thread document, and leaves the rest", () => {
        const exported = withoutSearchVectors({ _id: "t1", summaryVectorId: "s", title: "Hello", titleVectorId: "t" });

        expect(exported).toEqual({ _id: "t1", title: "Hello" });
    });

    it("embeds trimmed text only, and nothing for a blank one", () => {
        expect(searchText("  PDF  ")).toBe("PDF");
        expect(searchText(" ".repeat(3))).toBeUndefined();
        expect(searchText(null)).toBeUndefined();
    });
});
