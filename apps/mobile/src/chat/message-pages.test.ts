import { describe, expect, it, vi } from "vitest";

import type { MessagePage } from "./message-pages";
import { HISTORY_PAGE_SIZE, readNewestRows } from "./message-pages";

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
