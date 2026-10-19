import { describe, expect, it } from "vitest";

import { CHUNK_TARGET_TOKENS, chunkText, embeddingInput, estimateTokens } from "./chunking";

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

const paragraph = (word: string, words = 120): string => Array.from({ length: words }, (_, i) => `${word}${String(i)}`).join(" ");

describe("chunkText", () => {
    it("chunks text without headings exactly as before", () => {
        const text = Array.from({ length: 12 }, (_, i) => paragraph(`p${String(i)}w`)).join("\n\n");

        expect(chunkText(text)).toEqual(legacyChunkText(text));
    });

    it("treats a # line with no heading syntax as plain text", () => {
        const text = "#hashtag is not a heading\n\nsecond paragraph";

        expect(chunkText(text)).toEqual(legacyChunkText(text));
    });

    it("returns nothing for blank text", () => {
        expect(chunkText("  \n\n ")).toEqual([]);
    });

    it("starts a chunk at every heading and reports the heading path", () => {
        const chunks = chunkText("# Guide\n\nintro text\n\n## Limits\n\nrate limit text\n\n## Pricing\n\nprice text");

        expect(chunks.map((c) => c.sectionHeading)).toEqual(["Guide", "Guide > Limits", "Guide > Pricing"]);
        expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
        expect(chunks[1]?.content).toBe("## Limits\n\nrate limit text");
    });

    it("pops back up the path when a shallower heading arrives", () => {
        const chunks = chunkText("# A\n\na\n\n## B\n\nb\n\n### C\n\nc\n\n# D\n\nd");

        expect(chunks.map((c) => c.sectionHeading)).toEqual(["A", "A > B", "A > B > C", "D"]);
    });

    it("keeps text before the first heading without a section", () => {
        const chunks = chunkText("preamble\n\n# Title\n\nbody");

        expect(chunks[0]).toEqual({ content: "preamble", index: 0 });
        expect(chunks[1]?.sectionHeading).toBe("Title");
    });

    it("hands a heading-only section to the section after it", () => {
        const chunks = chunkText("# Title\n## Sub\n\nbody");

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ content: "# Title\n## Sub\n\nbody", sectionHeading: "Title > Sub" });
    });

    it("ignores # lines inside fenced code", () => {
        const chunks = chunkText("# Setup\n\n```sh\n# install deps\nnpm i\n```\n\nafter");

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.sectionHeading).toBe("Setup");
    });

    it("keeps a trailing # that belongs to the title", () => {
        expect(chunkText("# Why C#\n\nbody")[0]?.sectionHeading).toBe("Why C#");
        expect(chunkText("## Closed ##\n\nbody")[0]?.sectionHeading).toBe("Closed");
    });

    it("splits an oversize section by size and never carries overlap across a heading", () => {
        const text = `# Big\n\n${Array.from({ length: 8 }, (_, i) => paragraph(`b${String(i)}w`)).join("\n\n")}\n\n# Next\n\nnext body`;
        const chunks = chunkText(text);
        const big = chunks.filter((c) => c.sectionHeading === "Big");
        const next = chunks.find((c) => c.sectionHeading === "Next");

        expect(big.length).toBeGreaterThan(1);
        expect(next?.content).toBe("# Next\n\nnext body");
        expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    });

    it("caps a very long heading path", () => {
        const chunks = chunkText(`# ${"x".repeat(600)}\n\nbody`);

        expect(chunks[0]?.sectionHeading).toHaveLength(300);
    });
});

describe("page markers", () => {
    const pageOf = (n: number, body: string): string => `<!-- PAGE ${String(n)} -->\n\n${body}`;
    const withoutMarkers = (text: string): string => text.replaceAll(/<!-- PAGE \d+ -->\n\n/g, "");

    it("reads the page a chunk starts on and keeps the markers out of its text", () => {
        const text = `${pageOf(1, "first page text")}\n\n${pageOf(2, "second page text")}`;

        expect(chunkText(text)).toStrictEqual([{ content: "first page text\n\nsecond page text", index: 0, pageNumber: 1 }]);
    });

    it("gives every chunk the same text as the markerless text, so markers never move a boundary", () => {
        const pages = [1, 2, 3].map((n) => pageOf(n, Array.from({ length: 6 }, (_, i) => paragraph(`p${String(n)}_${String(i)}w`)).join("\n\n")));
        const text = pages.join("\n\n");
        const chunks = chunkText(text);

        expect(chunks.map((c) => c.content)).toStrictEqual(chunkText(withoutMarkers(text)).map((c) => c.content));
        expect(chunks.some((c) => c.content.includes("<!-- PAGE"))).toBe(false);
        expect(chunks.map((c) => c.pageNumber)).toStrictEqual([...chunks.map((c) => c.pageNumber)].toSorted((a, b) => (a ?? 0) - (b ?? 0)));
        expect(new Set(chunks.map((c) => c.pageNumber))).toStrictEqual(new Set([1, 2, 3]));
    });

    it("reports no page for text without markers", () => {
        expect(chunkText("just text\n\nmore text")).toStrictEqual([{ content: "just text\n\nmore text", index: 0 }]);
    });

    it("returns no chunks for text that is only markers", () => {
        expect(chunkText("<!-- PAGE 1 -->\n\n<!-- PAGE 2 -->")).toStrictEqual([]);
    });

    it("keeps a heading that ends a page with the section after it", () => {
        const chunks = chunkText("<!-- PAGE 1 -->\n\n# Title\n\n<!-- PAGE 2 -->\n\n## Next\n\nbody");

        expect(chunks).toStrictEqual([{ content: "# Title\n\n## Next\n\nbody", index: 0, pageNumber: 1, sectionHeading: "Title > Next" }]);
    });
});

describe("embeddingInput", () => {
    it("puts the section path in front of the body", () => {
        expect(embeddingInput({ content: "text", sectionHeading: "A > B" })).toBe("A > B\n\ntext");
    });

    it("is the body alone without a section", () => {
        expect(embeddingInput({ content: "text" })).toBe("text");
    });
});
