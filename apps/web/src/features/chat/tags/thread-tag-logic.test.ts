import { describe, expect, it } from "vitest";

import type { ThreadTag } from "./thread-tag-logic";
import { matchesThreadFilters, moveTag, pruneSelectedTagIds, resolveThreadTags, toggleSelectedTagId, withThreadTagIds } from "./thread-tag-logic";

const tag = (id: string, order: number): ThreadTag => {
    return { _id: id, color: "blue", name: id.toUpperCase(), order };
};

describe("matchesThreadFilters", () => {
    const thread = { category: "coding", tagIds: ["work", "urgent"] };

    it("passes everything when no filter is set", () => {
        expect(matchesThreadFilters(thread, { tagIds: [] })).toBe(true);
        expect(matchesThreadFilters({}, { tagIds: [] })).toBe(true);
    });

    it("filters by category alone", () => {
        expect(matchesThreadFilters(thread, { category: "coding", tagIds: [] })).toBe(true);
        expect(matchesThreadFilters(thread, { category: "writing", tagIds: [] })).toBe(false);
    });

    it("matches a thread carrying ANY selected tag", () => {
        expect(matchesThreadFilters(thread, { tagIds: ["urgent"] })).toBe(true);
        expect(matchesThreadFilters(thread, { tagIds: ["personal", "work"] })).toBe(true);
        expect(matchesThreadFilters(thread, { tagIds: ["personal"] })).toBe(false);
    });

    it("excludes untagged threads once a tag filter is active", () => {
        expect(matchesThreadFilters({ category: "coding" }, { tagIds: ["work"] })).toBe(false);
    });

    it("combines category AND tags", () => {
        expect(matchesThreadFilters(thread, { category: "coding", tagIds: ["work"] })).toBe(true);
        expect(matchesThreadFilters(thread, { category: "writing", tagIds: ["work"] })).toBe(false);
        expect(matchesThreadFilters(thread, { category: "coding", tagIds: ["personal"] })).toBe(false);
    });
});

describe("pruneSelectedTagIds", () => {
    const tags = [tag("a", 0), tag("b", 1)];

    it("drops ids of tags that no longer exist", () => {
        expect(pruneSelectedTagIds(["a", "gone"], tags)).toStrictEqual(["a"]);
    });

    it("returns the same array when nothing changed", () => {
        const selected = ["a", "b"];

        expect(pruneSelectedTagIds(selected, tags)).toBe(selected);
    });

    it("keeps the selection while tags are still loading", () => {
        const selected = ["a"];

        expect(pruneSelectedTagIds(selected, undefined)).toBe(selected);
    });
});

describe("resolveThreadTags", () => {
    it("returns tags in display order and skips unknown ids", () => {
        const tags = [tag("b", 1), tag("a", 0), tag("c", 2)];

        expect(resolveThreadTags(["c", "a", "deleted"], tags).map((t) => t._id)).toStrictEqual(["a", "c"]);
    });

    it("handles missing inputs", () => {
        expect(resolveThreadTags(undefined, [tag("a", 0)])).toStrictEqual([]);
        expect(resolveThreadTags(["a"], undefined)).toStrictEqual([]);
    });
});

describe("toggleSelectedTagId", () => {
    it("adds and removes", () => {
        expect(toggleSelectedTagId(["a"], "b")).toStrictEqual(["a", "b"]);
        expect(toggleSelectedTagId(["a", "b"], "a")).toStrictEqual(["b"]);
    });
});

describe("moveTag", () => {
    const tags = [tag("a", 0), tag("b", 1), tag("c", 2)];

    it("swaps with the neighbour", () => {
        expect(moveTag(tags, 1, -1)).toStrictEqual(["b", "a", "c"]);
        expect(moveTag(tags, 1, 1)).toStrictEqual(["a", "c", "b"]);
    });

    it("refuses to move past an edge", () => {
        expect(moveTag(tags, 0, -1)).toBeUndefined();
        expect(moveTag(tags, 2, 1)).toBeUndefined();
    });
});

describe("withThreadTagIds", () => {
    it("patches the thread everywhere it appears and leaves other lists untouched", () => {
        const threads = [{ _id: "t1" }, { _id: "t2", tagIds: ["x"] }];
        const pinned = [{ _id: "t2", tagIds: ["x"] }];
        const orders = [{ _id: "t3" }];
        const data = {
            pinnedThreads: pinned,
            temporaryThreads: { page: [] as { _id: string; tagIds?: string[] }[] },
            threadOrders: orders,
            threads: { isDone: true, page: threads },
        };

        const next = withThreadTagIds(data, "t2", ["x", "y"]);

        expect(next.threads.page[1]).toStrictEqual({ _id: "t2", tagIds: ["x", "y"] });
        expect(next.pinnedThreads[0]).toStrictEqual({ _id: "t2", tagIds: ["x", "y"] });
        expect(next.threads.isDone).toBe(true);
        expect(next.threadOrders).toBe(orders);
        expect(data.threads.page[1]).toStrictEqual({ _id: "t2", tagIds: ["x"] });
    });
});
