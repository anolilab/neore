import { afterEach, describe, expect, it } from "vitest";

import { collectRanges } from "./highlight";

afterEach(() => {
    document.body.replaceChildren();
});

describe("collectRanges", () => {
    it("returns a range per occurrence inside text nodes, ignoring case", () => {
        document.body.innerHTML = `<div data-find-text><p>Cat and <b>cat</b>, CAT</p></div>`;

        const ranges = collectRanges(document.body, "cat");

        expect(ranges.map((range) => range.toString())).toEqual(["Cat", "cat", "CAT"]);
    });

    it("skips script and style text", () => {
        document.body.innerHTML = "<div data-find-text><style>.cat{}</style><p>cat</p></div>";

        expect(collectRanges(document.body, "cat")).toHaveLength(1);
    });

    it("walks the text parts in order and leaves tool output out", () => {
        document.body.innerHTML = `<div data-tool>cat in a tool</div><div data-find-text>first cat</div><div data-tool>cat</div><div data-find-text>second cat</div>`;

        const ranges = collectRanges(document.body, "cat");

        expect(ranges).toHaveLength(2);
        expect(ranges.map((range) => range.startContainer.parentElement?.textContent)).toEqual(["first cat", "second cat"]);
    });

    it("returns nothing for a blank query", () => {
        document.body.innerHTML = "<div data-find-text><p>cat</p></div>";

        expect(collectRanges(document.body, " ")).toEqual([]);
    });
});
