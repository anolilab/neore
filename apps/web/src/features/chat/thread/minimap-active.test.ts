import { describe, expect, it } from "vitest";

import { isScrolledToEnd, lastReachedId, reachedRows } from "./minimap-active";

describe("lastReachedId", () => {
    it("picks the last prompt, in rail order, that has reached the band", () => {
        expect(lastReachedId(["a", "b", "c", "d"], new Set(["a", "b"]))).toBe("b");
    });

    it("is undefined when no prompt has reached the band yet", () => {
        expect(lastReachedId(["a", "b"], new Set())).toBeUndefined();
    });

    it("skips a prompt that was never observed, so an unmounted row is not picked", () => {
        expect(lastReachedId(["a", "b", "c"], new Set(["a", "c"]))).toBe("c");
        expect(lastReachedId(["a", "b"], new Set(["x"]))).toBeUndefined();
    });
});

describe("reachedRows", () => {
    const rows = [
        { id: "a", top: 100 },
        { id: "b", top: 450 },
        { id: "c", top: 600 },
    ];

    it("counts a row above the reading line only", () => {
        expect([...reachedRows(rows, 400, 800, false)]).toStrictEqual(["a"]);
    });

    it("counts every row on screen at the end of the list, so the newest prompt wins", () => {
        expect(lastReachedId(["a", "b", "c"], reachedRows(rows, 400, 800, true))).toBe("c");
    });
});

describe("isScrolledToEnd", () => {
    it("is true within a pixel of the end, and false above it", () => {
        expect(isScrolledToEnd({ clientHeight: 500, scrollHeight: 1000, scrollTop: 500 })).toBe(true);
        expect(isScrolledToEnd({ clientHeight: 500, scrollHeight: 1000, scrollTop: 499.5 })).toBe(true);
        expect(isScrolledToEnd({ clientHeight: 500, scrollHeight: 1000, scrollTop: 300 })).toBe(false);
    });
});
