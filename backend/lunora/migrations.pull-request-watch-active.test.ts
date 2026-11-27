import { describe, expect, it } from "vitest";

import { backfillPullRequestWatchActive } from "./migrations";

type Row = Record<string, unknown>;

const up = backfillPullRequestWatchActive.up as unknown as (document: Row) => Row | undefined;

const link = (extra: Row = {}): Row => {
    return { _id: "l1", number: 4, repository: "o/r", threadId: "t1", userId: "u1", ...extra };
};

describe("backfillPullRequestWatchActive", () => {
    it("flags a running watch on a live thread and changes nothing else", () => {
        expect.assertions(2);

        const row = link({ watch: { startedAt: 5, wakes: 2 }, watchPending: ["checks"] });
        const migrated = up(row);

        expect(migrated).toStrictEqual({ ...row, watchActive: true });
        expect(migrated?.watch).toStrictEqual(row.watch);
    });

    it("leaves a stopped watch, a watch on a deleted thread, a row without a watch, and a flagged row alone", () => {
        expect.assertions(5);

        expect(up(link({ watch: { startedAt: 5, stoppedAt: 9 } }))).toBeUndefined();
        expect(up(link({ threadDeleted: true, watch: { startedAt: 5 } }))).toBeUndefined();
        expect(up(link())).toBeUndefined();
        expect(up(link({ watch: undefined }))).toBeUndefined();
        expect(up(link({ watch: { startedAt: 5 }, watchActive: true }))).toBeUndefined();
    });

    it("flags a watch on a thread whose deleted mark is false", () => {
        expect.assertions(1);

        expect(up(link({ threadDeleted: false, watch: { startedAt: 5 } }))?.watchActive).toBe(true);
    });

    it("is idempotent: a second run over the first's output changes nothing", () => {
        expect.assertions(2);

        const once = up(link({ watch: { startedAt: 5 } }));

        expect(once).toBeDefined();
        expect(up(once as Row)).toBeUndefined();
    });
});
