import { describe, expect, it, vi } from "vitest";

import { collectAllThreadFollows } from "./export-pages";

const page = (follows: unknown[], readBytes: number, continueCursor?: string) => {
    return { continueCursor, follows, readBytes };
};

describe("collectAllThreadFollows", () => {
    it("reads every page when the budget allows, and is not cut", async () => {
        const readPage = vi.fn(async (cursor: string | undefined) => (cursor === undefined ? page(["a"], 10, "next") : page(["b"], 10)));

        await expect(collectAllThreadFollows(readPage, 1000)).resolves.toStrictEqual({ readBytes: 20, section: { follows: ["a", "b"], truncated: false } });
    });

    it("stops once the budget is spent and marks the section as cut", async () => {
        const readPage = vi.fn(async () => page(["a"], 600, "next"));

        await expect(collectAllThreadFollows(readPage, 1000)).resolves.toStrictEqual({ readBytes: 1200, section: { follows: ["a", "a"], truncated: true } });
        expect(readPage).toHaveBeenCalledTimes(2);
    });

    it("reads nothing with no budget left, and marks the section as cut", async () => {
        const readPage = vi.fn(async () => page(["a"], 10));

        await expect(collectAllThreadFollows(readPage, 0)).resolves.toStrictEqual({ readBytes: 0, section: { follows: [], truncated: true } });
        expect(readPage).not.toHaveBeenCalled();
    });
});
