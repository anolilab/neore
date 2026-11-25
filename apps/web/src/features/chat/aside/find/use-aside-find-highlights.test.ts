// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { collectAsideRanges, isClippedWithin, isOutsideViewport } from "./use-aside-find-highlights";

afterEach(() => {
    document.body.replaceChildren();
});

/** A panel of entries as `aside-panel.tsx` renders them: a row per entry, its question and answer marked searchable. */
const panel = (rows: string): string => `<section data-aside-find-host="">${rows}</section>`;
const row = (id: string, question: string, answer = ""): string =>
    `<li data-aside-entry-id="${id}"><p data-find-text="">${question}</p>${answer ? `<div data-find-text="">${answer}</div>` : ""}</li>`;

describe("isOutsideViewport", () => {
    const bounds = { bottom: 500, top: 100 };

    it("is false for a hit well inside the panel", () => {
        expect(isOutsideViewport({ bottom: 300, top: 280 }, bounds)).toBe(false);
    });

    it("is true for a hit above the panel, or in the band the sticky find bar covers", () => {
        expect(isOutsideViewport({ bottom: 90, top: 70 }, bounds)).toBe(true);
        expect(isOutsideViewport({ bottom: 130, top: 110 }, bounds)).toBe(true);
    });

    it("is true for a hit below the panel's visible bottom", () => {
        expect(isOutsideViewport({ bottom: 540, top: 520 }, bounds)).toBe(true);
    });
});

describe("collectAsideRanges", () => {
    it("counts every occurrence in panel order, question before answer, entry by entry", () => {
        document.body.innerHTML = panel(row("a", "Why cat?", "The cat sleeps.") + row("b", "A cat too"));

        const host = document.querySelector("section") as Element;
        const ranges = collectAsideRanges(host, "cat");

        expect(ranges.map((range) => range.toString())).toEqual(["cat", "cat", "cat"]);
        expect(ranges.map((range) => range.startContainer.parentElement?.closest<HTMLElement>("[data-aside-entry-id]")?.dataset.asideEntryId)).toEqual([
            "a",
            "a",
            "b",
        ]);
    });

    it("leaves out a control a rendered answer carries, such as a code block's show-all button", () => {
        document.body.innerHTML = panel(row("a", "Q", `<pre>cat</pre><button>Show all cat lines</button>`));

        const ranges = collectAsideRanges(document.querySelector("section") as Element, "cat");

        expect(ranges).toHaveLength(1);
        expect(ranges[0]?.startContainer.parentElement?.tagName).toBe("PRE");
    });

    it("counts only the text the page shows: an image's alt text is not text on the page", () => {
        document.body.innerHTML = panel(row("a", "Q", `<img alt="cat" src="x.png">`));

        expect(collectAsideRanges(document.querySelector("section") as Element, "cat")).toEqual([]);
    });

    it("matches a question's characters literally, as it is shown", () => {
        document.body.innerHTML = panel(row("a", "See [docs](https://example.com) and **bold**"));

        const host = document.querySelector("section") as Element;

        expect(collectAsideRanges(host, "docs](https")).toHaveLength(1);
        expect(collectAsideRanges(host, "**bold**")).toHaveLength(1);
    });

    it("does not count a match that spans rendered elements, so nothing counted is out of reach", () => {
        document.body.innerHTML = panel(row("a", "Q", `foo <strong>bar</strong>`));

        expect(collectAsideRanges(document.querySelector("section") as Element, "foo bar")).toEqual([]);
    });

    const TEX = String.raw`\frac{cat}{dog}`;

    it("does not count the TeX source a formula carries for screen readers, but counts the glyphs it shows", () => {
        document.body.innerHTML = panel(
            row(
                "a",
                "Q",
                `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>frac</mi></mrow><annotation encoding="application/x-tex">${TEX}</annotation></semantics></math></span><span class="katex-html">frac</span></span>`,
            ),
        );

        const host = document.querySelector("section") as Element;

        expect(collectAsideRanges(host, "cat")).toEqual([]);
        expect(collectAsideRanges(host, "frac")).toHaveLength(1);
    });

    it("returns nothing for a blank query", () => {
        document.body.innerHTML = panel(row("a", "cat"));

        expect(collectAsideRanges(document.querySelector("section") as Element, "  ")).toEqual([]);
    });
});

describe("isClippedWithin", () => {
    /** A hit at x 150 to 170 in a code block with the given inline style, whose own box spans `left` to `right`. */
    const clipped = (style: string, left: number, right: number): boolean => {
        document.body.innerHTML = panel(row("a", "Q", `<pre style="${style}"><code>wide cat</code></pre>`));

        const section = document.querySelector("section") as HTMLElement;
        const pre = section.querySelector("pre") as HTMLElement;
        const code = section.querySelector("code") as HTMLElement;

        Object.defineProperty(pre, "getBoundingClientRect", {
            configurable: true,
            value: () => {
                return { bottom: 100, left, right, top: 0 };
            },
        });

        return isClippedWithin({ bottom: 20, left: 150, right: 170, top: 10 }, code, section);
    };

    it("is true when a code block's own scroll viewport hides the hit the panel still shows", () => {
        expect(clipped("overflow-x: auto", 0, 100)).toBe(true);
    });

    it("is false when that scroll viewport still shows the hit", () => {
        expect(clipped("overflow-x: auto", 0, 300)).toBe(false);
    });

    it("is false when nothing between the hit and the panel clips it", () => {
        expect(clipped("", 0, 100)).toBe(false);
    });
});
