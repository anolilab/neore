import { describe, expect, it } from "vitest";

import { backfillMemoryRetiredAt } from "./migrations";

type Row = Record<string, unknown>;

const up = backfillMemoryRetiredAt.up as unknown as (document: Row) => Row | undefined;

const memory = (extra: Row = {}): Row => {
    return { _creationTime: 100, _id: "m1", memory: "likes tea", type: "preference", userId: "u1", ...extra };
};

describe("backfillMemoryRetiredAt", () => {
    it("dates a row retired before reasons were kept by its last write, else its creation, and gives it no reason", () => {
        expect.assertions(3);

        const row = memory({ supersededBy: "m2", updatedAt: 500 });

        expect(up(row)).toStrictEqual({ ...row, retiredAt: 500 });
        expect(up(memory({ supersededBy: "m1" }))?.retiredAt).toBe(100);
        expect(up(row)?.retiredReason).toBeUndefined();
    });

    it("leaves an active row and one already dated alone", () => {
        expect.assertions(3);

        expect(up(memory({ updatedAt: 500 }))).toBeUndefined();
        expect(up(memory({ supersededBy: null }))).toBeUndefined();
        expect(up(memory({ retiredAt: 400, retiredReason: "revised", supersededBy: "m2" }))).toBeUndefined();
    });
});
