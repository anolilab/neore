// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { collectAsideRanges } from "./use-aside-find-highlights";

afterEach(() => {
    document.body.replaceChildren();
});

/** A panel of entries as `aside-panel.tsx` renders them: a row per entry, its question and answer marked searchable. */
const panel = (rows: string): string => `<section data-aside-find-host="">${rows}</section>`;
const row = (id: string, question: string, answer = ""): string =>
    `<li data-aside-entry-id="${id}"><p data-find-text="">${question}</p>${answer ? `<div data-find-text="">${answer}</div>` : ""}</li>`;

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

    it("returns nothing for a blank query", () => {
        document.body.innerHTML = panel(row("a", "cat"));

        expect(collectAsideRanges(document.querySelector("section") as Element, "  ")).toEqual([]);
    });
});
