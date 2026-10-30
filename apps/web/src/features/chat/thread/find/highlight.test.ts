import { afterEach, describe, expect, it } from "vitest";

import { collectRanges } from "./highlight";

afterEach(() => {
    document.body.replaceChildren();
});

describe("collectRanges", () => {
    it("returns a range per occurrence inside text nodes, ignoring case", () => {
        document.body.innerHTML = "<p>Cat and <b>cat</b>, CAT</p>";

        const ranges = collectRanges(document.body, "cat");

        expect(ranges.map((range) => range.toString())).toEqual(["Cat", "cat", "CAT"]);
    });

    it("skips script and style text", () => {
        document.body.innerHTML = "<style>.cat{}</style><p>cat</p>";

        expect(collectRanges(document.body, "cat")).toHaveLength(1);
    });

    it("returns nothing for a blank query", () => {
        document.body.innerHTML = "<p>cat</p>";

        expect(collectRanges(document.body, " ")).toEqual([]);
    });
});
