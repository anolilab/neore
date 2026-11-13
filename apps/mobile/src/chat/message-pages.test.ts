import { describe, expect, it, vi } from "vitest";

import type { MessagePage, OlderPage } from "./message-pages";
import { fillHistory, HISTORY_PAGE_SIZE, MAX_FILL_PAGES, OPEN_FILL_ROWS, readNewestRows } from "./message-pages";

/** A thread of `pages` full pages: a fetch returns the next one older each time, as the server would. */
const history = (pages: number) =>
    vi.fn(async (cursor: string | null): Promise<MessagePage<string>> => {
        const index = cursor === null ? 0 : Number(cursor);

        return { continueCursor: String(index + 1), isDone: index + 1 >= pages, page: [`page-${index}`] };
    });

describe(readNewestRows, () => {
    it("opens a chat with one request for the newest page, however long the history", async () => {
        const fetchPage = history(10);

        const result = await readNewestRows(fetchPage, (message) => message.toUpperCase());

        expect(fetchPage.mock.calls).toStrictEqual([[null, HISTORY_PAGE_SIZE]]);
        expect(result).toStrictEqual({ olderCursor: "1", rows: ["PAGE-0"] });
    });

    it("leaves no older page to load when the newest one is the whole history", async () => {
        const result = await readNewestRows(history(1), (message) => message);

        expect(result.olderCursor).toBeNull();
    });
});

interface Shown {
    id: string;
}

/** Rows `from` to `to`, oldest first. */
const shownRow = (index: number): Shown => {
    return { id: `m${index}` };
};
const run = (from: number, to: number): Shown[] => Array.from({ length: to - from + 1 }, (_, index) => shownRow(from + index));

/**
 * A history of messages 1 to `last` served 20 to a page, as the server caps them: the cursor is the number of the
 * oldest message already served, and each fetch returns the 20 before it.
 */
const pagedHistory = () =>
    vi.fn(async (cursor: string): Promise<OlderPage<Shown>> => {
        const before = Number(cursor);
        const from = Math.max(1, before - 20);

        return { olderCursor: from === 1 ? null : String(from), rows: run(from, before - 1) };
    });

/** The screen's rows, written the way the screen writes them. */
const screenOf = (initial: Shown[]) => {
    const screen = { rows: initial };

    return {
        read: () => screen.rows,
        screen,
        write: (update: (rows: Shown[]) => Shown[]) => {
            screen.rows = update(screen.rows);
        },
    };
};

describe(fillHistory, () => {
    it("fills a chat just opened to as many rows as it opened with before, after the newest page", async () => {
        // A 300-message chat: the newest page (281-300) is on screen.
        const fetchOlder = pagedHistory();
        const { read, screen, write } = screenOf(run(281, 300));

        const result = await fillHistory({ anchorId: "m281", cursor: "281", fetchOlder, fillTo: OPEN_FILL_ROWS, read, write });

        expect(screen.rows).toStrictEqual(run(101, 300));
        expect(fetchOlder).toHaveBeenCalledTimes(9);
        expect(result).toStrictEqual({ cursor: "101", isStopped: false });
    });

    it("fills the gap between kept older rows and a fresh page, and stops at the first page that reaches them", async () => {
        // Rows 1-40 were on screen; the fresh newest page is 61-80, so 41-60 are missing.
        const fetchOlder = pagedHistory();
        const { read, screen, write } = screenOf([...run(1, 40), ...run(61, 80)]);

        await fillHistory({ anchorId: "m61", cursor: "61", fetchOlder, fillTo: 0, read, write });

        expect(screen.rows).toStrictEqual(run(1, 80));
        expect(fetchOlder).toHaveBeenCalledTimes(2);
    });

    it("fetches nothing for a refresh with no gap", async () => {
        const fetchOlder = pagedHistory();
        const { read, write } = screenOf(run(61, 80));

        await fillHistory({ anchorId: "m61", cursor: "61", fetchOlder, fillTo: 0, read, write });

        expect(fetchOlder).not.toHaveBeenCalled();
    });

    it("stops when a page cannot be read, leaving the rows and the cursor unused", async () => {
        const { read, screen, write } = screenOf(run(281, 300));

        const result = await fillHistory({ anchorId: "m281", cursor: "281", fetchOlder: async () => undefined, fillTo: OPEN_FILL_ROWS, read, write });

        expect(result.isStopped).toBe(true);
        expect(screen.rows).toStrictEqual(run(281, 300));
    });

    it("fetches at most a bounded number of pages", async () => {
        const fetchOlder = pagedHistory();
        const { read, write } = screenOf(run(9981, 10_000));

        await fillHistory({ anchorId: "m9981", cursor: "9981", fetchOlder, fillTo: 100_000, read, write });

        expect(fetchOlder).toHaveBeenCalledTimes(MAX_FILL_PAGES);
    });
});
