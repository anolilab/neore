import { describe, expect, it } from "vitest";

import { isOldestFreshRowOnScreen, mergeFreshRead, withFreshRows } from "./fresh-rows";

interface TestRow {
    finished?: boolean;
    id: string;
    status: string;
}

const row = (id: string, extra: Partial<TestRow> = {}): TestRow => {
    return { id, status: "success", ...extra };
};

describe("withFreshRows", () => {
    it("takes the fresh read as it is when no older pages were loaded", () => {
        const current = [row("old"), row("mid"), row("new")];
        const fresh = [row("mid"), row("new"), row("newest")];

        expect(withFreshRows(current, fresh, false)).toEqual(fresh);
    });

    it("keeps loaded older rows ahead of the fresh read when older pages are on screen", () => {
        const current = [row("a"), row("b"), row("c"), row("d")];
        const fresh = [row("c"), row("d")];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("does not duplicate a row the fresh read already has", () => {
        const current = [row("a"), row("b")];
        const fresh = [row("b")];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["a", "b"]);
    });

    it("drops local and finished rows, which the fresh read replaces", () => {
        const current = [row("kept"), row("pending", { status: "local" }), row("finished", { finished: true }), row("server")];
        const fresh = [row("server")];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["kept", "server"]);
    });

    it("drops older rows when the fresh read's oldest row is not on screen, so nothing is shown twice", () => {
        const current = [row("a"), row("b")];
        const fresh = [row("x"), row("y")];

        expect(withFreshRows(current, fresh, true)).toEqual(fresh);
    });

    it("reports whether the screen reaches the fresh read's oldest row", () => {
        const current = [row("a"), row("b")];

        expect(isOldestFreshRowOnScreen(current, [row("b"), row("c")])).toBe(true);
        expect(isOldestFreshRowOnScreen(current, [row("x"), row("y")])).toBe(false);
        expect(isOldestFreshRowOnScreen(current, [])).toBe(false);
    });
});

/** Rows `from` to `to`, oldest first, as a run of the history. */
const run = (from: number, to: number): TestRow[] => Array.from({ length: to - from + 1 }, (_, index) => row(`m${from + index}`));

describe(mergeFreshRead, () => {
    it("keeps the saved rows the cache painted before the fresh page, so they stay when the app goes offline", () => {
        const merged = mergeFreshRead(run(1, 50), run(31, 50), false);

        expect(merged.rows).toStrictEqual(run(1, 50));
        expect(merged).toMatchObject({ hasGap: false, keepsCursor: false });
    });

    it("keeps loaded older rows when more than a page of messages came after them, and reports the gap", () => {
        // Rows 1-40 were on screen, older pages loaded; 40 more messages came, and the fresh newest page is 61-80.
        const merged = mergeFreshRead(run(1, 40), run(61, 80), true);

        expect(merged.rows).toStrictEqual([...run(1, 40), ...run(61, 80)]);
        expect(merged).toMatchObject({ hasGap: true, keepsCursor: true });
    });

    it("keeps no local or finished row, which the fresh page replaces", () => {
        const merged = mergeFreshRead([row("old"), row("sending", { status: "local" }), row("done", { finished: true })], [row("new")], false);

        expect(merged.rows.map((shown) => shown.id)).toStrictEqual(["old", "new"]);
    });

    it("shows nothing for a chat whose newest page is empty", () => {
        expect(mergeFreshRead(run(1, 3), [], true)).toStrictEqual({ hasGap: false, keepsCursor: false, rows: [] });
    });
});
