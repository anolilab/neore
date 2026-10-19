import { describe, expect, it } from "vitest";

import { CHUNK_TARGET_TOKENS, chunkText, EMBEDDING_INPUT_BUDGET, embeddingInput, estimateTokens, markPage, withoutPageLines } from "./chunking";

/** The chunker as it was before headings: heading-less text must still come out exactly like this. */
const BLANK_LINE_RE = /\n\s*\n/;
const WHITESPACE_RE = /\s+/;

const legacyChunkText = (text: string): { content: string; index: number }[] => {
    const chunks: { content: string; index: number }[] = [];
    let currentChunk = "";
    let chunkIndex = 0;

    for (const paragraph of text.split(BLANK_LINE_RE)) {
        const trimmed = paragraph.trim();

        if (!trimmed) {
            continue;
        }

        if (estimateTokens(currentChunk) > 0 && estimateTokens(currentChunk) + estimateTokens(trimmed) > CHUNK_TARGET_TOKENS) {
            chunks.push({ content: currentChunk.trim(), index: chunkIndex });
            chunkIndex += 1;

            const words = currentChunk.trim().split(WHITESPACE_RE);
            const overlapWordCount = Math.min(Math.ceil(50 * 1.5), Math.floor(words.length / 3));

            currentChunk = overlapWordCount > 0 ? `${words.slice(-overlapWordCount).join(" ")}\n\n` : "";
        }

        currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
    }

    if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim(), index: chunkIndex });
    }

    return chunks;
};

const MARKDOWN = { markdown: true } as const;

const paragraph = (word: string, words = 120): string => Array.from({ length: words }, (_, i) => `${word}${String(i)}`).join(" ");

describe("chunkText", () => {
    it("chunks text without headings exactly as before", () => {
        const text = Array.from({ length: 12 }, (_, i) => paragraph(`p${String(i)}w`)).join("\n\n");

        expect(chunkText(text)).toEqual(legacyChunkText(text));
        expect(chunkText(text, MARKDOWN)).toEqual(legacyChunkText(text));
    });

    it("treats a # line with no heading syntax as plain text", () => {
        const text = "#hashtag is not a heading\n\nsecond paragraph";

        expect(chunkText(text)).toEqual(legacyChunkText(text));
    });

    it("returns nothing for blank text", () => {
        expect(chunkText("  \n\n ")).toEqual([]);
        expect(chunkText("  \n\n ", MARKDOWN)).toEqual([]);
    });

    it("keeps a code file's # comments in one chunk unless it is read as Markdown", () => {
        // A 1 KB python file: forty blocks, each opened by a comment line.
        const python = Array.from({ length: 40 }, (_, i) => `# step ${String(i)}\nvalue_${String(i)} = ${String(i)}`).join("\n\n");

        expect(chunkText(python)).toHaveLength(1);
        expect(chunkText(python)).toEqual(legacyChunkText(python));
        expect(chunkText(python, MARKDOWN)).toHaveLength(40);
    });

    it("starts a chunk at every heading and reports the heading path", () => {
        const chunks = chunkText("# Guide\n\nintro text\n\n## Limits\n\nrate limit text\n\n## Pricing\n\nprice text", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual(["Guide", "Guide > Limits", "Guide > Pricing"]);
        expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
        expect(chunks[1]?.content).toBe("## Limits\n\nrate limit text");
    });

    it("pops back up the path when a shallower heading arrives", () => {
        const chunks = chunkText("# A\n\na\n\n## B\n\nb\n\n### C\n\nc\n\n# D\n\nd", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual(["A", "A > B", "A > B > C", "D"]);
    });

    it("keeps text before the first heading without a section", () => {
        const chunks = chunkText("preamble\n\n# Title\n\nbody", MARKDOWN);

        expect(chunks[0]).toEqual({ content: "preamble", index: 0 });
        expect(chunks[1]?.sectionHeading).toBe("Title");
    });

    it("hands a heading-only section to the section after it", () => {
        const chunks = chunkText("# Title\n## Sub\n\nbody", MARKDOWN);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ content: "# Title\n## Sub\n\nbody", sectionHeading: "Title > Sub" });
    });

    it("ignores # lines inside fenced code", () => {
        const chunks = chunkText("# Setup\n\n```sh\n# install deps\nnpm i\n```\n\nafter", MARKDOWN);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBe("Setup");
    });

    it("closes a fence only with a run at least as long as its opening", () => {
        // The ```` block holds a ``` line as code, so its # comment is not a heading.
        const chunks = chunkText("````md\n```\n# not a heading\n```\n````\n\n# Real", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual([undefined, "Real"]);
    });

    it("does not close a fence on a line with an info string", () => {
        // ```python is code inside the ``` block, so its # line is code too.
        const chunks = chunkText("```sh\n# install\n```python\n# still code\n```\n\n# After", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual([undefined, "After"]);
    });

    it("closes a fence only with its own marker character", () => {
        const chunks = chunkText("~~~\n# x\n```\n~~~\n\n# After", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual([undefined, "After"]);
    });

    it("does not treat a closer followed by text as a closer", () => {
        const chunks = chunkText("```\n# a\n``` extra\n# b", MARKDOWN);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBeUndefined();
    });

    it("closes a fence on a longer run of the same marker", () => {
        expect(chunkText("```\n# inside\n````\n\n# After", MARKDOWN).map((c) => c.sectionHeading)).toEqual([undefined, "After"]);
    });

    it("closes a fence on a closer indented by up to three spaces", () => {
        expect(chunkText("```\n# inside\n   ```\n\n# After", MARKDOWN).map((c) => c.sectionHeading)).toEqual([undefined, "After"]);
    });

    it("does not open a backtick fence whose info string holds a backtick", () => {
        // ```a`b is inline code, so the # line after it is a heading.
        const chunks = chunkText("```a`b\n# head\n\nbody", MARKDOWN);

        expect(chunks.map((c) => c.sectionHeading)).toEqual([undefined, "head"]);
    });

    it("reads a heading indented by up to three spaces", () => {
        expect(chunkText("   ## Indented\n\nbody", MARKDOWN)[0]?.sectionHeading).toBe("Indented");
    });

    it("does not read a heading indented by four spaces as one", () => {
        const chunks = chunkText("    # not a heading\n\nbody", MARKDOWN);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBeUndefined();
    });

    it("does not read a heading after a leading tab as one", () => {
        const chunks = chunkText("\t# not a heading\n\nbody", MARKDOWN);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBeUndefined();
    });

    it("keeps a trailing # that belongs to the title", () => {
        expect(chunkText("# Why C#\n\nbody", MARKDOWN)[0]?.sectionHeading).toBe("Why C#");
        expect(chunkText("## Closed ##\n\nbody", MARKDOWN)[0]?.sectionHeading).toBe("Closed");
    });

    it("splits an oversize section by size and never carries overlap across a heading", () => {
        const text = `# Big\n\n${Array.from({ length: 8 }, (_, i) => paragraph(`b${String(i)}w`)).join("\n\n")}\n\n# Next\n\nnext body`;
        const chunks = chunkText(text, MARKDOWN);
        const big = chunks.filter((c) => c.sectionHeading === "Big");
        const next = chunks.find((c) => c.sectionHeading === "Next");

        expect(big.length).toBeGreaterThan(1);
        expect(next?.content).toBe("# Next\n\nnext body");
        expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    });

    it("caps a very long heading path", () => {
        const chunks = chunkText(`# ${"x".repeat(600)}\n\nbody`, MARKDOWN);

        expect(chunks[0]?.sectionHeading).toHaveLength(300);
    });
});

describe("page lines", () => {
    const pageOf = (n: number, body: string): string => markPage(n, body);
    const withoutPageText = (text: string): string => text.replaceAll(/PAGE \d+\n\n/gu, "");

    it("reads the page a chunk starts on and keeps the page lines out of its text", () => {
        const text = `${pageOf(1, "first page text")}\n\n${pageOf(2, "second page text")}`;

        expect(chunkText(text, MARKDOWN)).toStrictEqual([{ content: "first page text\n\nsecond page text", index: 0, pageNumber: 1 }]);
    });

    it("gives every chunk the same text as the page-less text, so page lines never move a boundary", () => {
        const pages = [1, 2, 3].map((n) => pageOf(n, Array.from({ length: 6 }, (_, i) => paragraph(`p${String(n)}_${String(i)}w`)).join("\n\n")));
        const text = pages.join("\n\n");
        const chunks = chunkText(text, MARKDOWN);

        expect(chunks.map((c) => c.content)).toStrictEqual(chunkText(withoutPageText(text), MARKDOWN).map((c) => c.content));
        expect(chunks.some((c) => c.content.includes(""))).toBe(false);
        expect(chunks.map((c) => c.pageNumber)).toStrictEqual([...chunks.map((c) => c.pageNumber)].toSorted((a, b) => (a ?? 0) - (b ?? 0)));
        expect(new Set(chunks.map((c) => c.pageNumber))).toStrictEqual(new Set([1, 2, 3]));
    });

    it("reports no page for text without page lines", () => {
        expect(chunkText("just text\n\nmore text", MARKDOWN)).toStrictEqual([{ content: "just text\n\nmore text", index: 0 }]);
    });

    it("returns no chunks for text that is only page lines", () => {
        expect(chunkText(`${markPage(1, "")}\n\n${markPage(2, "")}`, MARKDOWN)).toStrictEqual([]);
    });

    it("keeps a heading that ends a page with the section after it", () => {
        const chunks = chunkText(`${markPage(1, "# Title")}\n\n${markPage(2, "## Next\n\nbody")}`, MARKDOWN);

        expect(chunks).toStrictEqual([{ content: "# Title\n\n## Next\n\nbody", index: 0, pageNumber: 1, sectionHeading: "Title > Next" }]);
    });

    it("leaves page lines and headings in the text unless asked to read Markdown", () => {
        const text = markPage(1, "# Title\n\nbody");

        expect(chunkText(text)).toStrictEqual([{ content: text, index: 0 }]);
    });

    it("pins the page line format the ingest writes", () => {
        // The chunker reads the line markPage writes, and nothing else: the format is internal to the backend.
        expect(markPage(7, "body")).toBe("PAGE 7\n\nbody");
        expect(chunkText(markPage(7, "body"), MARKDOWN)).toStrictEqual([{ content: "body", index: 0, pageNumber: 7 }]);
    });

    it("strips the private-use code point from the text, so a document cannot forge a page", () => {
        const text = markPage(1, "before\nPAGE 9\n\nafter");

        expect(text.split("")).toHaveLength(2);
        expect(chunkText(text, MARKDOWN)).toStrictEqual([{ content: "before\nPAGE 9\n\nafter", index: 0, pageNumber: 1 }]);
    });

    it("reads a literal comment line as text, not as a page", () => {
        const chunks = chunkText("<!-- PAGE 2 -->\n\nbody", MARKDOWN);

        expect(chunks).toStrictEqual([{ content: "<!-- PAGE 2 -->\n\nbody", index: 0 }]);
    });
});

describe("embeddingInput", () => {
    it("puts the section path in front of the body", () => {
        expect(embeddingInput({ content: "text", sectionHeading: "A > B" }, 2000)).toBe("A > B\n\ntext");
    });

    it("is the body alone without a section", () => {
        expect(embeddingInput({ content: "text" }, 2000)).toBe("text");
    });

    it("cuts the body, not the heading path, to fit the budget", () => {
        const body = `${"x".repeat(2500)}TAIL`;
        const input = embeddingInput({ content: body, sectionHeading: "Guide" }, 2000);

        expect(input).toBe(`Guide\n\n${body.slice(0, 2000 - "Guide\n\n".length)}`);
        expect(input).toHaveLength(2000);
    });

    it("trims the heading path, never the body below its minimum, and stays within the budget", () => {
        const input = embeddingInput({ content: "x".repeat(1000), sectionHeading: "H".repeat(300) }, 300);

        expect(input).toBe(`${"H".repeat(100)}${"x".repeat(200)}`);
    });

    it("cuts a section-less input to the budget", () => {
        expect(embeddingInput({ content: "x".repeat(2500) }, 2000)).toHaveLength(2000);
    });

    it("embeds every chunk whole under the longest heading path, not only the first part of it", () => {
        // Paragraphs of 1500-1900 characters: each is a chunk of its own, and the longest sits past the old 1698-character body.
        const paragraphs = Array.from({ length: 6 }, (_, i) => `p${String(i)} ${"x".repeat(1500 + ((i * 137) % 400))}`);
        const chunks = chunkText(`# ${"H".repeat(600)}\n\n${paragraphs.join("\n\n")}`, MARKDOWN);

        expect(Math.max(...chunks.map((c) => c.content.length))).toBeGreaterThan(1698);

        for (const chunk of chunks) {
            const input = embeddingInput(chunk, EMBEDDING_INPUT_BUDGET);

            expect(input.length).toBeLessThanOrEqual(EMBEDDING_INPUT_BUDGET);
            expect(input.endsWith(chunk.content)).toBe(true);
        }
    });
});

describe("chunkText headings and pages are separate switches", () => {
    const text = `${markPage(1, "# Slide title\n\nbody one")}\n\n${markPage(2, "body two")}`;

    it("reads page lines without reading a '# ' line as a heading (slide text)", () => {
        const chunks = chunkText(text, { pages: true });

        expect(chunks.every((chunk) => chunk.sectionHeading === undefined)).toBe(true);
        expect(chunks[0]?.content).toContain("# Slide title");
        expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([1]);
        expect(chunks.map((chunk) => chunk.content).join("")).not.toContain("");
    });

    it("reads headings without reading a literal comment line as a page (a Markdown file)", () => {
        const chunks = chunkText("# Title\n\nbody\n\n<!-- PAGE 2 -->\n\nmore", { headings: true });

        expect(chunks[0]?.sectionHeading).toBe("Title");
        expect(chunks[0]?.pageNumber).toBeUndefined();
        expect(chunks[0]?.content).toContain("<!-- PAGE 2 -->");
    });

    it("still takes `markdown` as both", () => {
        expect(chunkText(text, { markdown: true })[0]).toMatchObject({ pageNumber: 1, sectionHeading: "Slide title" });
    });
});

describe("setext headings", () => {
    const headings = (text: string): (string | undefined)[] => chunkText(text, { headings: true }).map((chunk) => chunk.sectionHeading);

    it("reads '===' under a paragraph line as a level-1 heading, split before that line", () => {
        const chunks = chunkText("Intro text\n\nTitle\n=====\n\nBody text", { headings: true });

        expect(chunks).toStrictEqual([
            { content: "Intro text", index: 0 },
            { content: "Title\n=====\n\nBody text", index: 1, sectionHeading: "Title" },
        ]);
    });

    it("reads '---' under a paragraph line as a level-2 heading under its parent", () => {
        const chunks = chunkText("# Top\n\nintro\n\nSub\n---\n\nbody", { headings: true });

        expect(chunks.map((chunk) => chunk.sectionHeading)).toStrictEqual(["Top", "Top > Sub"]);
        expect(chunks[1]?.content).toBe("Sub\n---\n\nbody");
    });

    it("keeps a thematic break after a blank line out of the headings", () => {
        expect(headings("Para one\n\n---\n\nPara two")).toStrictEqual([undefined]);
        expect(headings("Para one\n\n===\n\nPara two")).toStrictEqual([undefined]);
    });

    it("keeps YAML front matter out of the headings", () => {
        const chunks = chunkText("---\ntitle: Guide\nauthor: Ada\n---\n\nBody text", { headings: true });

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBeUndefined();
        expect(chunks[0]?.content).toContain("author: Ada");
    });

    it("does not read a '# comment' inside front matter as a heading", () => {
        const chunks = chunkText("---\ntitle: Guide\n# draft note\n---\n\nBody text", { headings: true });

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBeUndefined();
        expect(chunks[0]?.content).toContain("# draft note");
    });

    it("still reads a heading right after the front matter", () => {
        const chunks = chunkText("---\ntitle: Guide\n---\n\n# Real heading\n\nBody", { headings: true });

        expect(chunks.at(-1)?.sectionHeading).toBe("Real heading");
    });

    it("keeps a table row out of the headings", () => {
        expect(headings("| Name | Score |\n---")).toStrictEqual([undefined]);
    });

    it("keeps a list item out of the headings", () => {
        for (const item of ["- item one", "* star", "+ plus", "1. first", "2) second"]) {
            expect(headings(`${item}\n---\n\nbody`)).toStrictEqual([undefined]);
            expect(headings(`${item}\n===\n\nbody`)).toStrictEqual([undefined]);
        }
    });

    it("keeps a fenced code block out of the headings", () => {
        expect(headings("```\nTitle\n=====\n```\n\nafter")).toStrictEqual([undefined]);
        expect(headings("~~~\nTitle\n---\n~~~\n\nafter")).toStrictEqual([undefined]);
    });

    it("does not underline an ATX heading", () => {
        const chunks = chunkText("# Title\n=====\n\nbody", { headings: true });

        expect(chunks).toStrictEqual([{ content: "# Title\n=====\n\nbody", index: 0, sectionHeading: "Title" }]);
    });

    it("does not underline a line the ingest appends its tables under", () => {
        const chunks = chunkText("Body text\n\n---\n## Extracted Tables\n\n### Table 1\n| a |", { headings: true });

        expect(chunks[0]).toStrictEqual({ content: "Body text\n\n---", index: 0 });
        expect(chunks.map((chunk) => chunk.sectionHeading)).toStrictEqual([undefined, "Extracted Tables > Table 1"]);
    });

    it("does not underline an indented (code) line", () => {
        const chunks = chunkText("    code line\n---", { headings: true });

        expect(chunks).toStrictEqual([{ content: "code line\n---", index: 0 }]);
    });

    it("reads only the last line of a multi-line paragraph as the heading", () => {
        const chunks = chunkText("First line\nSecond line\n===\n\nbody", { headings: true });

        expect(chunks).toStrictEqual([
            { content: "First line", index: 0 },
            { content: "Second line\n===\n\nbody", index: 1, sectionHeading: "Second line" },
        ]);
    });

    it("folds a setext title with no body into the section after it", () => {
        const chunks = chunkText("Title\n===\n\n## Sub\n\nbody", { headings: true });

        expect(chunks).toStrictEqual([{ content: "Title\n===\n\n## Sub\n\nbody", index: 0, sectionHeading: "Title > Sub" }]);
    });

    it("reads nothing as a setext heading without the headings option", () => {
        expect(chunkText("Title\n=====\n\nbody")).toStrictEqual([{ content: "Title\n=====\n\nbody", index: 0 }]);
    });
});

describe("withoutPageLines", () => {
    it("drops the page lines and keeps the rest, for the summary prompt", () => {
        const text = `${markPage(1, "First page.")}\n\n${markPage(2, "Second page.")}`;

        expect(withoutPageLines(text)).toBe("\nFirst page.\n\n\nSecond page.");
        expect(withoutPageLines(text)).not.toContain("\u{E000}");
        expect(withoutPageLines("plain text")).toBe("plain text");
    });
});
