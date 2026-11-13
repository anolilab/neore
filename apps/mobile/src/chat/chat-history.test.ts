import { describe, expect, it, vi } from "vitest";

import type { ChatHistory, HistoryPage, HistoryRow } from "./chat-history";
import {
    createLoadingOwner,
    fillHistory,
    MAX_FILL_PAGES,
    newestRun,
    nextOlderCursor,
    olderPageOf,
    OPEN_FILL_ROWS,
    withNewestPage,
    withOlderPage,
} from "./chat-history";

const row = (id: string, extra: Partial<HistoryRow> = {}): HistoryRow => {
    return { id, status: "success", ...extra };
};

/** Messages `from` to `to` of a chat's active path, oldest first. */
const run = (from: number, to: number, prefix = "m"): HistoryRow[] => Array.from({ length: to - from + 1 }, (_, index) => row(`${prefix}${from + index}`));

const ids = (rows: ReadonlyArray<HistoryRow>): string[] => rows.map((shown) => shown.id);

/**
 * A chat of messages 1 to `last` served as the server serves them, 20 to a page: the cursor is the number of the oldest
 * message already served, and a page holds the 20 before it.
 */
const serverOf = () =>
    vi.fn(async (cursor: string): Promise<HistoryPage<HistoryRow>> => {
        const before = Number(cursor);
        const from = Math.max(1, before - 20);

        return { olderCursor: from === 1 ? null : String(from), rows: run(from, before - 1) };
    });

/** The screen's history, read and written the way the screen does it. */
const screenOf = (initial: ChatHistory<HistoryRow>) => {
    const screen = { history: initial };

    return {
        read: () => screen.history,
        screen,
        update: (apply: (history: ChatHistory<HistoryRow>) => ChatHistory<HistoryRow>) => {
            screen.history = apply(screen.history);
        },
    };
};

const EMPTY: ChatHistory<HistoryRow> = { olderCursor: undefined, rows: [] };

describe("a chat opened and filled", () => {
    it("fills to as many rows as it opened with before, and keeps the cursor below the oldest row through the next read", async () => {
        const fetchOlder = serverOf();
        const { read, screen, update } = screenOf(withNewestPage(EMPTY, { olderCursor: "281", rows: run(281, 300) }));

        await fillHistory({ fetchOlder, fillTo: OPEN_FILL_ROWS, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(101, 300)));
        expect(fetchOlder).toHaveBeenCalledTimes(9);
        expect(screen.history.olderCursor).toBe("101");

        // A message is sent and the newest page is read again: "Load older messages" goes on below the 200 rows shown,
        // not from just below the newest page.
        const next = withNewestPage(screen.history, { olderCursor: "282", rows: run(282, 301) });

        expect(ids(next.rows)).toStrictEqual(ids(run(101, 301)));
        expect(nextOlderCursor(next)).toBe("101");
    });

    it("confirms the saved rows the cache painted from the first page that reaches them, then fills on", async () => {
        const fetchOlder = serverOf();
        // The cache painted messages 251-300; the first read brings 281-300 with nothing known below the saved rows.
        const painted: ChatHistory<HistoryRow> = { olderCursor: undefined, rows: run(251, 300) };
        const { read, screen, update } = screenOf(withNewestPage(painted, { olderCursor: "281", rows: run(281, 300) }));

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(251, 300)));

        await fillHistory({ fetchOlder, fillTo: OPEN_FILL_ROWS, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(101, 300)));
        expect(screen.history.gap).toBeUndefined();
    });
});

describe("a refresh that does not reach the rows on screen", () => {
    it("keeps them below a marked hole and fills it down to them", async () => {
        const fetchOlder = serverOf();
        // Rows 1-40 were on screen; 40 messages came, and the newest page is 61-80.
        const shown: ChatHistory<HistoryRow> = { olderCursor: null, rows: run(1, 40) };
        const { read, screen, update } = screenOf(withNewestPage(shown, { olderCursor: "61", rows: run(61, 80) }));

        expect(screen.history.gap).toStrictEqual({ anchorId: "m61", cursor: "61", keptCursor: null });

        await fillHistory({ fetchOlder, fillTo: 0, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(1, 80)));
        expect(screen.history.gap).toBeUndefined();
        expect(nextOlderCursor(screen.history)).toBeNull();
        expect(fetchOlder).toHaveBeenCalledTimes(2);
    });

    it("keeps the hole marked when the fill stops early, so the next read of older rows goes on with it", async () => {
        const shown: ChatHistory<HistoryRow> = { olderCursor: null, rows: run(1, 40) };
        const { read, screen, update } = screenOf(withNewestPage(shown, { olderCursor: "100", rows: run(100, 119) }));
        const fetchOlder = vi.fn(async (cursor: string) => {
            if (cursor !== "100") {
                return undefined;
            }

            return { olderCursor: "80", rows: run(80, 99) };
        });

        await fillHistory({ fetchOlder, fillTo: 0, read, save: () => {}, update });

        expect(screen.history.gap).toStrictEqual({ anchorId: "m80", cursor: "80", keptCursor: null });
        expect(nextOlderCursor(screen.history)).toBe("80");
        // The next newest read leaves the hole where it was.
        expect(withNewestPage(screen.history, { olderCursor: "101", rows: run(101, 120) }).gap).toStrictEqual(screen.history.gap);
    });

    it("keeps the hole marked after the most pages one fill reads", async () => {
        const fetchOlder = serverOf();
        const shown: ChatHistory<HistoryRow> = { olderCursor: null, rows: run(1, 20) };
        const { read, screen, update } = screenOf(withNewestPage(shown, { olderCursor: "1001", rows: run(1001, 1020) }));

        await fillHistory({ fetchOlder, fillTo: 0, read, save: () => {}, update });

        expect(fetchOlder).toHaveBeenCalledTimes(MAX_FILL_PAGES);
        expect(screen.history.gap?.cursor).toBe("801");
    });
});

describe("another branch of the chat", () => {
    it("drops the rows of the old path once the fill reaches the messages the two share", async () => {
        // The old path was 1-30 then a31-a40; the active one is 1-30 then b31-b60, and its newest page is b41-b60.
        const shown: ChatHistory<HistoryRow> = { olderCursor: null, rows: [...run(1, 30), ...run(31, 40, "a")] };
        const { read, screen, update } = screenOf(withNewestPage(shown, { olderCursor: "b41", rows: run(41, 60, "b") }));
        const pages: Record<string, HistoryPage<HistoryRow>> = {
            b31: { olderCursor: "11", rows: run(11, 30) },
            b41: { olderCursor: "b31", rows: run(31, 40, "b") },
        };

        await fillHistory({ fetchOlder: async (cursor) => pages[cursor], fillTo: 0, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids([...run(1, 30), ...run(31, 60, "b")]));
    });

    it("drops every kept row when the fill reaches the start of the chat without meeting them", () => {
        const history: ChatHistory<HistoryRow> = { gap: { anchorId: "b1", cursor: "start", keptCursor: null }, olderCursor: undefined, rows: [...run(1, 5, "a"), ...run(1, 5, "b")] };

        const next = withOlderPage(history, { olderCursor: null, rows: [] });

        expect(ids(next.rows)).toStrictEqual(ids(run(1, 5, "b")));
        expect(next.gap).toBeUndefined();
    });
});

describe(newestRun, () => {
    it("is what the fill saves: the rows from the newest down to the hole, without rows made on the screen", async () => {
        const save = vi.fn();
        const fetchOlder = serverOf();
        const { read, update } = screenOf(withNewestPage(EMPTY, { olderCursor: "41", rows: run(41, 60) }));

        await fillHistory({ fetchOlder, fillTo: OPEN_FILL_ROWS, read, save, update });

        expect(ids(save.mock.calls[0]?.[0] as HistoryRow[])).toStrictEqual(ids(run(1, 60)));
        const withHole: ChatHistory<HistoryRow> = {
            gap: { anchorId: "m10", cursor: "10", keptCursor: null },
            olderCursor: undefined,
            rows: [...run(1, 3), ...run(10, 12), row("x", { status: "local" })],
        };
        const saved = newestRun(withHole);

        expect(ids(saved)).toStrictEqual(ids(run(10, 12)));
    });
});

describe(olderPageOf, () => {
    it("clears a chat the server refuses while its older pages are read, as the newest-page read does", () => {
        const onRefused = vi.fn();
        const onFailure = vi.fn();

        expect(olderPageOf({ kind: "refused" }, { onFailure, onRefused })).toBeUndefined();
        expect(onRefused).toHaveBeenCalledOnce();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it("passes a page on, reports a failure, and drops a read the screen moved on from", () => {
        const onRefused = vi.fn();
        const onFailure = vi.fn();

        expect(olderPageOf({ kind: "page", olderCursor: null, rows: [] }, { onFailure, onRefused })).toStrictEqual({ olderCursor: null, rows: [] });
        expect(olderPageOf({ kind: "superseded" }, { onFailure, onRefused })).toBeUndefined();
        olderPageOf({ kind: "unreachable" }, { onFailure, onRefused });

        expect(onFailure).toHaveBeenCalledOnce();
        expect(onRefused).not.toHaveBeenCalled();
    });
});

describe(createLoadingOwner, () => {
    it("lets only the latest fill or press end the loading state, not one it superseded", () => {
        const setLoading = vi.fn();
        const owner = createLoadingOwner(setLoading);
        const endFirst = owner.begin();
        const endSecond = owner.begin();

        endFirst();

        expect(setLoading.mock.calls.at(-1)).toStrictEqual([true]);

        endSecond();

        expect(setLoading.mock.calls.at(-1)).toStrictEqual([false]);
    });
});
