import { describe, expect, it, vi } from "vitest";

import type { ChatHistory, HistoryPage, HistoryRow } from "./chat-history";
import {
    createFillRunner,
    createLoadingOwner,
    fillHistory,
    MAX_FILL_PAGES,
    newestRun,
    nextOlderCursor,
    olderPageOf,
    OPEN_FILL_ROWS,
    requiresFill,
    withFillTarget,
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

/** The history after a read of the newest page `rows`, whose older history starts at `olderCursor`. */
const newest = (history: ChatHistory<HistoryRow>, olderCursor: string, rows: HistoryRow[]) => withNewestPage(history, { olderCursor, rows });

/** A chat just opened on the newest page `rows`: it fills to as many rows as a chat opens with. */
const opening = (history: ChatHistory<HistoryRow>, olderCursor: string, rows: HistoryRow[]) => withFillTarget(newest(history, olderCursor, rows), OPEN_FILL_ROWS);

describe("a chat opened and filled", () => {
    it("fills to as many rows as it opened with before, and keeps the cursor below the oldest row through the next read", async () => {
        const fetchOlder = serverOf();
        const { read, screen, update } = screenOf(opening(EMPTY, "281", run(281, 300)));

        await fillHistory({ fetchOlder, read, save: () => {}, update });

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
        const { read, screen, update } = screenOf(opening(painted, "281", run(281, 300)));

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(251, 300)));

        await fillHistory({ fetchOlder, read, save: () => {}, update });

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

        await fillHistory({ fetchOlder, read, save: () => {}, update });

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

        await fillHistory({ fetchOlder, read, save: () => {}, update });

        expect(screen.history.gap).toStrictEqual({ anchorId: "m80", cursor: "80", keptCursor: null });
        expect(nextOlderCursor(screen.history)).toBe("80");
        // The next newest read leaves the hole where it was.
        expect(withNewestPage(screen.history, { olderCursor: "101", rows: run(101, 120) }).gap).toStrictEqual(screen.history.gap);
    });

    it("keeps the hole marked after the most pages one fill reads", async () => {
        const fetchOlder = serverOf();
        const shown: ChatHistory<HistoryRow> = { olderCursor: null, rows: run(1, 20) };
        const { read, screen, update } = screenOf(withNewestPage(shown, { olderCursor: "1001", rows: run(1001, 1020) }));

        await fillHistory({ fetchOlder, read, save: () => {}, update });

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

        await fillHistory({ fetchOlder: async (cursor) => pages[cursor], read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids([...run(1, 30), ...run(31, 60, "b")]));
    });

    it("drops every kept row when the fill reaches the start of the chat without meeting them", () => {
        const history: ChatHistory<HistoryRow> = { gap: { anchorId: "b1", cursor: "start", keptCursor: null }, olderCursor: undefined, rows: [...run(1, 5, "a"), ...run(1, 5, "b")] };

        const next = withOlderPage(history, { olderCursor: null, rows: [] }, "start");

        expect(ids(next.rows)).toStrictEqual(ids(run(1, 5, "b")));
        expect(next.gap).toBeUndefined();
    });
});

describe(newestRun, () => {
    it("is what the fill saves: the rows from the newest down to the hole, without rows made on the screen", async () => {
        const save = vi.fn();
        const fetchOlder = serverOf();
        const { read, update } = screenOf(opening(EMPTY, "41", run(41, 60)));

        await fillHistory({ fetchOlder, read, save, update });

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

describe("an older page that lands after the history moved", () => {
    it("is dropped when a newest-page read opened a hole meanwhile, so no row lands in the wrong place", () => {
        // Rows 81-100 are on screen; "Load older messages" reads from "81".
        const pressed: ChatHistory<HistoryRow> = { olderCursor: "81", rows: run(81, 100) };
        const asked = nextOlderCursor(pressed);
        // Before the page lands, a newest-page read finds 40 new messages: a hole now sits below 121-140.
        const refreshed = withNewestPage(pressed, { olderCursor: "121", rows: run(121, 140) });

        const landed = withOlderPage(refreshed, { olderCursor: "61", rows: run(61, 80) }, asked ?? "");

        expect(landed).toBe(refreshed);
        expect(ids(landed.rows)).toStrictEqual(ids([...run(81, 100), ...run(121, 140)]));
        expect(nextOlderCursor(landed)).toBe("121");
    });

    it("is applied when the history still reads from where the page was asked for", () => {
        const pressed: ChatHistory<HistoryRow> = { olderCursor: "81", rows: run(81, 100) };
        // A newest-page read that reaches the rows keeps the cursor below them.
        const refreshed = withNewestPage(pressed, { olderCursor: "82", rows: run(82, 101) });

        const landed = withOlderPage(refreshed, { olderCursor: "61", rows: run(61, 80) }, "81");

        expect(ids(landed.rows)).toStrictEqual(ids(run(61, 101)));
        expect(nextOlderCursor(landed)).toBe("61");
    });
});

describe("a second refresh before a hole is closed", () => {
    it("keeps every row on screen, both holes marked, and fills from the newest page all the way down", async () => {
        const fetchOlder = serverOf();
        // Rows 1-20 were on screen; a refresh brought 61-80 and left a hole below them, still open.
        const firstRefresh = withNewestPage({ olderCursor: null, rows: run(1, 20) }, { olderCursor: "61", rows: run(61, 80) });
        // Before the hole is filled, 40 more messages come: the next newest page is 101-120.
        const { read, screen, update } = screenOf(withNewestPage(firstRefresh, { olderCursor: "101", rows: run(101, 120) }));

        expect(ids(screen.history.rows)).toStrictEqual(ids([...run(1, 20), ...run(61, 80), ...run(101, 120)]));
        expect(screen.history.gap).toStrictEqual({
            anchorId: "m101",
            cursor: "101",
            keptCursor: undefined,
            keptGap: { anchorId: "m61", cursor: "61", keptCursor: null },
        });

        await fillHistory({ fetchOlder, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(1, 120)));
        expect(screen.history.gap).toBeUndefined();
    });

    it("keeps the run above the first hole on screen when the read below the second one fails", async () => {
        const served = serverOf();
        const asked: string[] = [];
        let isOnline = false;
        const fetchOlder = async (cursor: string) => {
            if (!isOnline) {
                return undefined;
            }

            asked.push(cursor);

            return await served(cursor);
        };
        const firstRefresh = withNewestPage({ olderCursor: null, rows: run(1, 20) }, { olderCursor: "61", rows: run(61, 80) });
        const { read, screen, update } = screenOf(withNewestPage(firstRefresh, { olderCursor: "101", rows: run(101, 120) }));

        await expect(fillHistory({ fetchOlder, read, save: () => {}, update })).resolves.toBe("stopped");

        // 61-80, served by the first refresh, stay shown although no page has reached them since.
        expect(ids(screen.history.rows)).toStrictEqual(ids([...run(1, 20), ...run(61, 80), ...run(101, 120)]));
        expect(nextOlderCursor(screen.history)).toBe("101");

        isOnline = true;
        await fillHistory({ fetchOlder, read, save: () => {}, update });

        // The page that reaches 61 joins the first hole, so the fill goes on from its cursor, not from inside 61-80.
        expect(asked).toStrictEqual(["101", "81", "61", "41", "21"]);
        expect(ids(screen.history.rows)).toStrictEqual(ids(run(1, 120)));
    });
});

describe("an opening fill that stops early", () => {
    it("is taken up again by the next read, until the chat holds as many rows as it opens with", async () => {
        const fetchOlder = serverOf();
        const opened = withFillTarget(withNewestPage(EMPTY, { olderCursor: "281", rows: run(281, 300) }), OPEN_FILL_ROWS);
        const { read, screen, update } = screenOf(opened);
        let reads = 0;

        // The fill reads two pages, then a newer read supersedes it.
        await fillHistory({
            fetchOlder: async (cursor) => {
                reads += 1;

                return reads <= 2 ? await fetchOlder(cursor) : undefined;
            },
            read,
            save: () => {},
            update,
        });

        expect(screen.history.rows).toHaveLength(60);

        // The next newest-page read (after a send) still asks for the fill, which goes on from where it stopped.
        update((history) => withNewestPage(history, { olderCursor: "282", rows: run(282, 301) }));

        expect(requiresFill(screen.history)).toBe(true);

        await fillHistory({ fetchOlder, read, save: () => {}, update });

        expect(ids(screen.history.rows)).toStrictEqual(ids(run(101, 301)));
        expect(requiresFill(screen.history)).toBe(false);
        expect(screen.history.fillTarget).toBeUndefined();
    });
});

describe("an opening fill across a branch switch", () => {
    it("keeps filling to the target when the rows kept below the hole were an old branch the fill drops", async () => {
        // On screen: 100-130, then a131-a330 of a branch since left. The active path is 1-130, then b131-b180.
        const shown: ChatHistory<HistoryRow> = { olderCursor: "100", rows: [...run(100, 130), ...run(131, 330, "a")] };
        const { read, screen, update } = screenOf(opening(shown, "b161", run(161, 180, "b")));
        const server = serverOf();
        const pages: Record<string, HistoryPage<HistoryRow>> = {
            b141: { olderCursor: "121", rows: [...run(121, 130), ...run(131, 140, "b")] },
            b161: { olderCursor: "b141", rows: run(141, 160, "b") },
        };
        const asked: string[] = [];

        // The screen holds over 200 rows while the hole is open, but most of them go when it closes.
        expect(screen.history.rows.length).toBeGreaterThan(OPEN_FILL_ROWS);

        await fillHistory({
            fetchOlder: async (cursor) => {
                asked.push(cursor);

                return pages[cursor] ?? await server(cursor);
            },
            read,
            save: () => {},
            update,
        });

        expect(asked).toStrictEqual(["b161", "b141", "100", "80", "60", "40", "20"]);
        expect(ids(screen.history.rows)).toStrictEqual(ids([...run(1, 130), ...run(131, 180, "b")]));
        expect(screen.history.fillTarget).toBeUndefined();
    });
});

describe(createFillRunner, () => {
    it("runs one fill at a time: a request while one runs is taken up by it, then the fill runs once more", async () => {
        const runner = createFillRunner<string>();
        const started: string[] = [];
        let release: (() => void) | undefined;
        const fill = async (key: string) => {
            started.push(key);

            if (started.length === 1) {
                // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node 22.11; the package allows 22.0
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            }
        };

        const first = runner.request({ fill, isCurrent: () => true, key: "t1" });
        const second = runner.request({ fill, isCurrent: () => true, key: "t1" });

        expect(started).toStrictEqual(["t1"]);

        release?.();
        await Promise.all([first, second]);

        expect(started).toStrictEqual(["t1", "t1"]);
    });

    it("stops a running fill when another chat asks for one, or its request is no longer current", async () => {
        const runner = createFillRunner<string>();
        const checks: boolean[] = [];
        let release: (() => void) | undefined;
        let isCurrent = true;

        const first = runner.request({
            fill: async (_key, check) => {
                checks.push(check());
                // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node 22.11; the package allows 22.0
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                checks.push(check());
            },
            isCurrent: () => isCurrent,
            key: "t1",
        });

        isCurrent = false;

        expect(checks).toStrictEqual([true]);

        const second = runner.request({ fill: async (_key, check) => {
            checks.push(check());
        }, isCurrent: () => true, key: "t2" });

        release?.();
        await Promise.all([first, second]);

        expect(checks).toStrictEqual([true, false, true]);
    });

    it("keeps a fill stopped once the screen left its chat, even when the screen comes back to that chat meanwhile", async () => {
        const runner = createFillRunner<string>();
        const checks: string[] = [];
        let release: (() => void) | undefined;
        let epoch = 1;
        const requestFor = (key: string) => {
            const mine = epoch;

            return runner.request({
                fill: async (_key, check) => {
                    checks.push(`${key}@${String(mine)}:${String(check())}`);

                    if (mine === 1) {
                        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node 22.11; the package allows 22.0
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        checks.push(`${key}@${String(mine)}:${String(check())}`);
                    }
                },
                isCurrent: () => epoch === mine,
                key,
            });
        };

        const first = requestFor("t1");

        // The screen goes to another chat and back while the first fill's page is in flight.
        epoch = 2;

        const second = requestFor("t2");

        epoch = 3;

        const third = requestFor("t1");

        release?.();
        await Promise.all([first, second, third]);

        expect(checks).toStrictEqual(["t1@1:true", "t1@1:false", "t1@3:true"]);
    });
});

describe("a chat opened on saved rows", () => {
    it("confirms the saved rows against the server page by page, and never asks again for a row already confirmed", async () => {
        const served = serverOf();
        const confirmed = new Set(ids(run(281, 300)));
        const asked: string[] = [];
        const fetchOlder = async (cursor: string) => {
            asked.push(cursor);

            const page = await served(cursor);

            expect(ids(page.rows).filter((id) => confirmed.has(id))).toStrictEqual([]);

            for (const id of ids(page.rows)) {
                confirmed.add(id);
            }

            return page;
        };
        // The cache painted the 50 newest messages, 251-300; the newest page is 281-300.
        const { read, screen, update } = screenOf(newest({ olderCursor: undefined, rows: run(251, 300) }, "281", run(281, 300)));

        await fillHistory({ fetchOlder, read, save: () => {}, update });

        expect(asked).toStrictEqual(["281", "261"]);
        expect(ids(screen.history.rows)).toStrictEqual(ids(run(241, 300)));
        expect(screen.history.gap).toBeUndefined();
        // Below the oldest row the server confirmed, not just below the first page it read.
        expect(nextOlderCursor(screen.history)).toBe("241");
    });
});

describe("an older page that shares only some of the kept rows", () => {
    it("keeps the page's rows older than the first kept row it shares, and the kept rows older still below a hole", () => {
        // The screen keeps saved rows A and B below a hole; the next page holds X, B and Y.
        const history: ChatHistory<HistoryRow> = { gap: { anchorId: "r1", cursor: "r1", keptCursor: undefined }, olderCursor: undefined, rows: [row("A"), row("B"), row("r1")] };

        const next = withOlderPage(history, { olderCursor: "X", rows: [row("X"), row("B"), row("Y")] }, "r1");

        expect(ids(next.rows)).toStrictEqual(["A", "X", "B", "Y", "r1"]);
        expect(next.gap).toStrictEqual({ anchorId: "X", cursor: "X", keptCursor: undefined });

        // The page below reaches A: the hole closes, and nothing on screen is read again.
        const closed = withOlderPage(next, { olderCursor: "W", rows: [row("W"), row("A")] }, "X");

        expect(ids(closed.rows)).toStrictEqual(["W", "A", "X", "B", "Y", "r1"]);
        expect(closed.gap).toBeUndefined();
        expect(nextOlderCursor(closed)).toBe("W");
    });
});

describe("a chat opened on saved rows with some missing", () => {
    it("keeps every row the server serves between them, and reads none of the run again", async () => {
        const served = serverOf();
        const asked: string[] = [];
        // The cache holds 251-260 and 271-300 (261-270 were never saved); the newest page is 281-300.
        const painted: ChatHistory<HistoryRow> = { olderCursor: undefined, rows: [...run(251, 260), ...run(271, 300)] };
        const { read, screen, update } = screenOf(newest(painted, "281", run(281, 300)));
        const fetchOlder = async (cursor: string) => {
            asked.push(cursor);

            const page = await served(cursor);
            const runIds = new Set(ids(newestRun(screen.history)));

            expect(ids(page.rows).filter((id) => runIds.has(id))).toStrictEqual([]);

            return page;
        };

        await fillHistory({ fetchOlder, read, save: () => {}, update });

        expect(asked).toStrictEqual(["281", "261"]);
        expect(ids(screen.history.rows)).toStrictEqual(ids(run(241, 300)));
        expect(screen.history.gap).toBeUndefined();
        expect(nextOlderCursor(screen.history)).toBe("241");
    });
});

/** A small deterministic random source (Park-Miller), so a failing case can be replayed from its seed. */
const randomOf = (seed: number) => {
    let state = seed;

    return (below: number): number => {
        state = (state * 48_271) % 2_147_483_647;

        return state % below;
    };
};

describe("any split of a chat into pages", () => {
    it("never reads a row of the run again, loses no row, keeps the order, and drops rows not on the chat, through refreshes and failed reads", async () => {
        const runner = createFillRunner<string>();

        for (let seed = 1; seed <= 400; seed += 1) {
            const random = randomOf(seed);
            let last = 20 + random(100);
            const pageSize = () => 1 + random(25);
            /** Pages of random size: the cursor is the number of the oldest message already served. */
            const fetchFrom = (before: number): HistoryPage<HistoryRow> => {
                const from = Math.max(1, before - pageSize());

                return { olderCursor: from === 1 ? null : String(from), rows: run(from, before - 1) };
            };
            const newestPage = () => fetchFrom(last + 1);
            // The cache holds a stretch of the chat with rows missing, and some rows of another branch.
            const cacheFrom = 1 + random(last);
            const cached = run(cacheFrom, Math.min(last, cacheFrom + random(60))).filter(() => random(5) !== 0);
            const painted = cached.flatMap((shown) => [...random(8) === 0 ? [row(`x${shown.id}`)] : [], shown]);
            const { read, screen, update } = screenOf({ olderCursor: undefined, rows: painted });
            /** Rows a read of the server showed in the run that joins the newest row: they stay on screen. */
            const confirmed = new Set<string>();
            /** Rows on screen an older page held since the last newest-page read: one page may read a row again, to join it. */
            let readAgain = new Set<string>();
            let isFailing = false;
            const refresh = () => {
                readAgain = new Set();
                update((history) => withNewestPage(history, newestPage()));
            };
            const check = () => {
                const shownIds = ids(screen.history.rows);
                const shown = shownIds.filter((id) => id.startsWith("m")).map((id) => Number(id.slice(1)));

                expect(shown, `seed ${seed}: order`).toStrictEqual(shown.toSorted((a, b) => a - b));

                const shownSet = new Set(shownIds);

                expect([...confirmed].filter((id) => !shownSet.has(id)), `seed ${seed}: a confirmed row lost`).toStrictEqual([]);

                const newestRunIds = ids(newestRun(screen.history));

                for (const id of newestRunIds) {
                    confirmed.add(id);
                }

                const oldest = Number(newestRunIds[0]?.slice(1) ?? last + 1);

                expect(newestRunIds, `seed ${seed}: the run joins the newest row`).toStrictEqual(ids(run(oldest, last)));
                const isUnread = screen.history.olderCursor === undefined && screen.history.gap === undefined;

                expect(nextOlderCursor(screen.history), `seed ${seed}: the cursor is below the run`).toBe(isUnread || oldest === 1 ? null : String(oldest));
            };
            /** Cursors whose page landed with no refresh meanwhile: the history has moved below them, and never asks again. */
            const answered = new Set<string>();
            let inFlight = 0;
            const pendingFills: Promise<void>[] = [];
            /** Asks the runner for a fill (set below, once `fetchOlder` is there). */
            let fill = async (): Promise<void> => {};
            const fetchOlder = async (cursor: string) => {
                inFlight += 1;

                // Checked without `expect` on every page: thousands of pages are read here.
                if (inFlight !== 1 || answered.has(cursor)) {
                    expect.fail(`seed ${seed}: ${inFlight === 1 ? `cursor ${cursor} asked for again` : "two fills read at once"}`);
                }

                await Promise.resolve();
                inFlight -= 1;

                if (isFailing && random(3) === 0) {
                    return undefined;
                }

                const runIds = new Set(ids(newestRun(screen.history)));
                const onScreen = new Set(ids(screen.history.rows));
                const page = fetchFrom(Number(cursor));

                expect(ids(page.rows).filter((id) => runIds.has(id)), `seed ${seed}: a row of the run read again`).toStrictEqual([]);

                const shownAgain = ids(page.rows).filter((id) => onScreen.has(id));

                expect(shownAgain.filter((id) => readAgain.has(id)), `seed ${seed}: a row on screen read again twice`).toStrictEqual([]);

                for (const id of shownAgain) {
                    readAgain.add(id);
                }

                // A refresh lands while the page is on its way, and asks for a fill while this one runs.
                if (random(4) === 0) {
                    last += random(40);
                    refresh();
                    check();
                    pendingFills.push(fill());
                } else {
                    answered.add(cursor);
                }

                return page;
            };
            // Every fill goes through the runner, as the screen's do; a refresh that lands mid-fill asks for one too.

            fill = async () => {
                await runner.request({
                    fill: async (_key, isCurrent) => await fillHistory({ fetchOlder, isCurrent, read, save: () => {}, update }),
                    isCurrent: () => true,
                    key: "chat",
                });
            };

            update((history) => withFillTarget(withNewestPage(history, newestPage()), Infinity));
            check();

            isFailing = true;

            for (let step = 0; step < 8; step += 1) {
                // Newest-page reads, sometimes several in a row, while a hole may be open.
                while (random(2) === 0) {
                    last += random(40);
                    refresh();
                    check();
                }

                // eslint-disable-next-line no-await-in-loop -- each step reads after the one before
                await fill();
                check();
            }

            isFailing = false;

            while (nextOlderCursor(screen.history) !== null) {
                // eslint-disable-next-line no-await-in-loop -- each fill goes on from where the one before stopped
                await fill();
                check();
            }

            // eslint-disable-next-line no-await-in-loop -- the fills the refreshes asked for ended with the ones awaited
            await Promise.all(pendingFills);

            expect(ids(screen.history.rows), `seed ${seed}: the whole chat`).toStrictEqual(ids(run(1, last)));
        }
        // 400 seeds take a few seconds alone, and several times that beside the other test files.
    }, 60_000);
});

describe("saved rows the server no longer holds", () => {
    /** A row made at `createdAt`, as the server stamps every message. */
    const at = (id: string, createdAt: number) => row(id, { createdAt });

    it("drops a saved row a page reached past, and closes the hole instead of reading on below it", () => {
        // The cache painted c1 and c2; c1 was deleted on the server since. The newest page does not reach them.
        const opened = withNewestPage({ olderCursor: undefined, rows: [at("c1", 2), at("c2", 3)] }, { olderCursor: "k", rows: [at("n1", 4)] });
        // The page below the newest one holds x and c2: c1, made after x, would be in it were it on the chat.
        const next = withOlderPage(opened, { olderCursor: "j", rows: [at("x", 1), at("c2", 3)] }, "k");

        expect(ids(next.rows)).toStrictEqual(["x", "c2", "n1"]);
        expect(next.gap).toBeUndefined();
        expect(nextOlderCursor(next)).toBe("j");
    });

    it("keeps rows below an older hole when a page reaches past a deleted row above it", () => {
        // A run served down to r5 (r4 of it deleted since), kept above a hole over r1 and r2, kept from before.
        const history: ChatHistory<HistoryRow> = {
            gap: { anchorId: "n1", cursor: "k", keptCursor: undefined, keptGap: { anchorId: "r4", cursor: "h", keptCursor: "older" } },
            olderCursor: undefined,
            rows: [at("r1", 1), at("r2", 2), at("r4", 4), at("r5", 5), at("n1", 6)],
        };
        const next = withOlderPage(history, { olderCursor: "j", rows: [at("r3", 3), at("r5", 5)] }, "k");

        expect(ids(next.rows)).toStrictEqual(["r1", "r2", "r3", "r5", "n1"]);
        expect(next.gap?.anchorId).toBe("r3");
        expect(next.gap?.cursor).toBe("j");
    });

    it("keeps saved rows older than the page below a hole, wherever the cache missed rows", () => {
        // The cache has c1 and c3 (c2 was never saved), and c4, deleted on the server since.
        const opened = withNewestPage({ olderCursor: undefined, rows: [at("c1", 1), at("c3", 3), at("c4", 4)] }, { olderCursor: "k", rows: [at("n1", 6)] });
        const next = withOlderPage(opened, { olderCursor: "j", rows: [at("c2", 2), at("c3", 3), at("c5", 5)] }, "k");

        expect(ids(next.rows)).toStrictEqual(["c1", "c2", "c3", "c5", "n1"]);
        expect(next.gap?.anchorId).toBe("c2");
    });

    it("ends a fill where it would end without them, and shows no row of them above an older one, for any split", async () => {
        const made = (id: string) => at(id, Number(id.slice(1)));

        for (let seed = 1; seed <= 400; seed += 1) {
            const random = randomOf(seed);
            const last = 100 + random(300);
            const target = 20 + random(40);
            // The cache holds the newest stretch the chat had, with some of its rows deleted on the server since.
            const cacheFrom = Math.max(1, last - random(80));
            const deleted = new Set(ids(run(cacheFrom, last)).filter(() => random(6) === 0));
            const onServer = ids(run(1, last)).filter((id) => !deleted.has(id));
            const position = (id: string) => onServer.indexOf(id);
            /** Pages of random size; the cursor is the position of the oldest row already served. */
            const fetchFrom = (before: number): HistoryPage<HistoryRow> => {
                const from = Math.max(0, before - 1 - random(25));

                return { olderCursor: from === 0 ? null : String(from), rows: onServer.slice(from, before).map((id) => made(id)) };
            };
            const cached = ids(run(cacheFrom, last)).filter(() => random(5) !== 0).map((id) => made(id));
            const { read, screen, update } = screenOf({ olderCursor: undefined, rows: cached });
            const asked: number[] = [];
            const fetchOlder = async (cursor: string) => {
                asked.push(Number(cursor));

                return fetchFrom(Number(cursor));
            };

            update((history) => withFillTarget(withNewestPage(history, fetchFrom(onServer.length)), target));

            for (let fills = 0; fills < 40 && requiresFill(screen.history); fills += 1) {
                // eslint-disable-next-line no-await-in-loop -- each fill goes on from where the one before stopped
                await fillHistory({ fetchOlder, read, save: () => {}, update });
            }

            const shown = ids(screen.history.rows).map((id) => Number(id.slice(1)));

            expect(shown, `seed ${seed}: order`).toStrictEqual(shown.toSorted((a, b) => a - b));
            expect(requiresFill(screen.history), `seed ${seed}: the fill ended`).toBe(false);

            // Down to the oldest saved row, or as far as the target, and at most one page below that.
            const needed = Math.min(position(onServer.find((id) => Number(id.slice(1)) >= cacheFrom) ?? ""), onServer.length - target);
            const lowest = Math.min(...asked);

            expect(lowest, `seed ${seed}: read to ${String(lowest)}, needed ${String(needed)}`).toBeGreaterThanOrEqual(Math.max(1, needed - 25));
            expect(ids(screen.history.rows).filter((id) => deleted.has(id)), `seed ${seed}: deleted rows left on screen`).toStrictEqual([]);
        }
    }, 60_000);
});

describe("an empty newest page that is not the chat's end", () => {
    it("keeps the rows on screen and reads on from the page's cursor", () => {
        const shown = withNewestPage({ olderCursor: null, rows: run(1, 20) }, { olderCursor: "61", rows: run(61, 80) });
        const next = withNewestPage(shown, { olderCursor: "next", rows: [] });

        expect(ids(next.rows)).toStrictEqual(ids(shown.rows));
        expect(nextOlderCursor(next)).toBe("next");
    });

    it("lets saved rows whose place is not known yet read on from the page's cursor, and joins them when a page reaches them", () => {
        const next = withNewestPage({ olderCursor: undefined, rows: run(41, 60) }, { olderCursor: "61", rows: [] });

        expect(ids(next.rows)).toStrictEqual(ids(run(41, 60)));
        expect(nextOlderCursor(next)).toBe("61");

        // The page below the empty one reaches the saved rows: they are on the chat, and the hole moves to its oldest row.
        const joined = withOlderPage(next, { olderCursor: "41", rows: run(41, 60) }, "61");

        expect(ids(joined.rows)).toStrictEqual(ids(run(41, 60)));
        expect(nextOlderCursor(joined)).toBe("41");
    });

    it("lets an empty screen read on from the page's cursor", () => {
        const next = withNewestPage({ olderCursor: undefined, rows: [] }, { olderCursor: "next", rows: [] });

        expect(nextOlderCursor(next)).toBe("next");
    });

    it("still ends the chat when the empty page is its end", () => {
        expect(withNewestPage({ olderCursor: "41", rows: run(41, 60) }, { olderCursor: null, rows: [] })).toStrictEqual({ olderCursor: null, rows: [] });
    });
});

describe("an empty older page under a hole that is not the chat's end", () => {
    it("keeps the rows kept below the hole and reads on from the page's cursor", () => {
        const shown = withNewestPage({ olderCursor: "1", rows: run(1, 20) }, { olderCursor: "61", rows: run(61, 80) });
        const next = withOlderPage(shown, { olderCursor: "50", rows: [] }, "61");

        expect(ids(next.rows)).toStrictEqual(ids([...run(1, 20), ...run(61, 80)]));
        expect(nextOlderCursor(next)).toBe("50");
        expect(next.gap?.anchorId).toBe("m61");
    });
});
