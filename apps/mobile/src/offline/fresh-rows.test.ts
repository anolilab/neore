import { describe, expect, it } from "vitest";

import { withFreshRows } from "./fresh-rows";

interface TestRow {
    createdAt: number;
    finished?: boolean;
    id: string;
    status: string;
}

const row = (id: string, createdAt: number, extra: Partial<TestRow> = {}): TestRow => {
    return { createdAt, id, status: "success", ...extra };
};

describe("withFreshRows", () => {
    it("takes the fresh read as it is when no older pages were loaded", () => {
        const current = [row("old", 1), row("mid", 2), row("new", 3)];
        const fresh = [row("mid", 2), row("new", 3), row("newest", 4)];

        expect(withFreshRows(current, fresh, false)).toEqual(fresh);
    });

    it("keeps loaded older rows ahead of the fresh read when older pages are on screen", () => {
        const current = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
        const fresh = [row("c", 3), row("d", 4)];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("places older rows by list position, not by creation time", () => {
        const current = [row("a", 9), row("b", 1), row("c", 3)];
        const fresh = [row("c", 3), row("d", 4)];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps distinct messages that share the oldest fresh row's millisecond", () => {
        const current = [row("sameMs-1", 5), row("sameMs-2", 5), row("newer", 6)];
        const fresh = [row("sameMs-2", 5), row("newer", 6)];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["sameMs-1", "sameMs-2", "newer"]);
    });

    it("does not duplicate a row the fresh read already has", () => {
        const current = [row("a", 1), row("b", 2)];
        const fresh = [row("b", 2)];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["a", "b"]);
    });

    it("drops local and finished rows, which the fresh read replaces", () => {
        const current = [row("kept", 1), row("pending", 2, { status: "local" }), row("finished", 3, { finished: true }), row("server", 4)];
        const fresh = [row("server", 4)];

        expect(withFreshRows(current, fresh, true).map((item) => item.id)).toEqual(["kept", "server"]);
    });

    it("drops older rows when the fresh read's oldest row is not on screen, so nothing is shown twice", () => {
        const current = [row("a", 1), row("b", 2)];
        const fresh = [row("x", 3), row("y", 4)];

        expect(withFreshRows(current, fresh, true)).toEqual(fresh);
    });
});
