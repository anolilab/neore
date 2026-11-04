import { describe, expect, it } from "vitest";

import { withFreshRows } from "./fresh-rows";

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
});
