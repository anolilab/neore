import { describe, expect, it } from "vitest";

import { findNewArrivals } from "./new-arrivals";

const item = (id: string, read = false) => {
    return { _id: id, read };
};

describe("findNewArrivals", () => {
    it("announces nothing on the first snapshot", () => {
        expect(findNewArrivals(undefined, [item("a"), item("b")])).toEqual([]);
    });

    it("announces unread items not seen before", () => {
        expect(findNewArrivals(new Set(["a"]), [item("c"), item("b", true), item("a")])).toEqual([item("c")]);
    });

    it("announces nothing when an item is only marked read", () => {
        expect(findNewArrivals(new Set(["a"]), [item("a", true)])).toEqual([]);
    });
});
