import { describe, expect, it } from "vitest";

import { scanPages } from "./scan-pages";

const source = (total: number, size: number) => {
    const fetched: (string | null)[] = [];

    return {
        fetched,
        fetchPage: async (cursor: string | null) => {
            fetched.push(cursor);
            const start = cursor === null ? 0 : Number(cursor);
            const end = Math.min(start + size, total);

            return { continueCursor: String(end), isDone: end >= total, page: Array.from({ length: end - start }, (_, index) => start + index) };
        },
    };
};

describe("scanPages", () => {
    it("reaches a row far past any fixed count and stops there", async () => {
        const { fetched, fetchPage } = source(1000, 50);

        await scanPages(fetchPage, (item) => item === 700);

        expect(fetched).toHaveLength(15);
    });

    it("visits every row of a short source", async () => {
        const { fetchPage } = source(120, 50);
        const seen: number[] = [];

        await scanPages(fetchPage, (item) => {
            seen.push(item);

            return false;
        });

        expect(seen).toHaveLength(120);
    });

    it("stops at the page budget", async () => {
        const { fetched, fetchPage } = source(1000, 10);

        await scanPages(fetchPage, () => false, 3);

        expect(fetched).toHaveLength(3);
    });
});
