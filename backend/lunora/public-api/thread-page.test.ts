import { describe, expect, it } from "vitest";

import { collectUnlockedThreads } from "./thread-page";

interface Row {
    id: string;
    lockedAt?: number;
}

const open = (id: string): Row => {
    return { id };
};
const locked = (id: string): Row => {
    return { id, lockedAt: 1 };
};

/** A fake paginated source over `rows`; `cursor` is the index of the next row, as a string. */
const source = (rows: Row[]) => {
    const calls: { cursor: string | null; numberItems: number }[] = [];
    const fetchPage = async (cursor: string | null, numberItems: number) => {
        calls.push({ cursor, numberItems });
        const start = cursor === null ? 0 : Number(cursor);
        const page = rows.slice(start, start + numberItems);

        return { continueCursor: String(start + page.length), isDone: start + page.length >= rows.length, page };
    };

    return { calls, fetchPage };
};

describe(collectUnlockedThreads, () => {
    it("returns a full page past a run of locked chats, asking only for the shortfall", async () => {
        const { calls, fetchPage } = source([locked("a"), locked("b"), open("c"), open("d"), open("e")]);
        const result = await collectUnlockedThreads(fetchPage, null, 2);

        expect(result.threads.map((t) => t.id)).toEqual(["c", "d"]);
        expect(result.continueCursor).toBe("4");
        expect(result.isDone).toBe(false);
        expect(calls.map((c) => c.numberItems)).toEqual([2, 2]);
    });

    it("never returns more than the limit", async () => {
        const { fetchPage } = source([open("a"), locked("b"), open("c"), open("d")]);
        const result = await collectUnlockedThreads(fetchPage, null, 2);

        expect(result.threads.map((t) => t.id)).toEqual(["a", "c"]);
        expect(result.continueCursor).toBe("3");
    });

    it("stops when the list ends and reports it", async () => {
        const { fetchPage } = source([locked("a"), open("b")]);
        const result = await collectUnlockedThreads(fetchPage, null, 5);

        expect(result.threads.map((t) => t.id)).toEqual(["b"]);
        expect(result.isDone).toBe(true);
    });

    it("gives up after a bounded number of reads and still returns a usable cursor", async () => {
        const rows = Array.from({ length: 40 }, (_, i) => locked(`l${i}`));
        const { calls, fetchPage } = source(rows);
        const result = await collectUnlockedThreads(fetchPage, null, 2);

        expect(result.threads).toEqual([]);
        expect(calls).toHaveLength(5);
        expect(result.isDone).toBe(false);
        expect(result.continueCursor).toBe("10");
    });

    it("passes an ordinary list through unchanged", async () => {
        const { calls, fetchPage } = source([open("a"), open("b"), open("c")]);
        const result = await collectUnlockedThreads(fetchPage, null, 2);

        expect(result.threads.map((t) => t.id)).toEqual(["a", "b"]);
        expect(calls).toHaveLength(1);
    });
});
