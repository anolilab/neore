import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CHUNK_TARGET_TOKENS, chunkText, EMBEDDING_INPUT_BUDGET, embeddingInput, estimateTokens } from "./chunking";

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

/** The marker's format string as shape.rs writes it, `format!("<!-- PAGE {number} -->…")`. */
const WRITTEN_MARKER_RE = /format!\("(<!-- PAGE \{number\} -->)/u;

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

describe("page markers", () => {
    const pageOf = (n: number, body: string): string => `<!-- PAGE ${String(n)} -->\n\n${body}`;
    const withoutMarkers = (text: string): string => text.replaceAll(/<!-- PAGE \d+ -->\n\n/g, "");

    it("reads the page a chunk starts on and keeps the markers out of its text", () => {
        const text = `${pageOf(1, "first page text")}\n\n${pageOf(2, "second page text")}`;

        expect(chunkText(text, MARKDOWN)).toStrictEqual([{ content: "first page text\n\nsecond page text", index: 0, pageNumber: 1 }]);
    });

    it("gives every chunk the same text as the markerless text, so markers never move a boundary", () => {
        const pages = [1, 2, 3].map((n) => pageOf(n, Array.from({ length: 6 }, (_, i) => paragraph(`p${String(n)}_${String(i)}w`)).join("\n\n")));
        const text = pages.join("\n\n");
        const chunks = chunkText(text, MARKDOWN);

        expect(chunks.map((c) => c.content)).toStrictEqual(chunkText(withoutMarkers(text), MARKDOWN).map((c) => c.content));
        expect(chunks.some((c) => c.content.includes("<!-- PAGE"))).toBe(false);
        expect(chunks.map((c) => c.pageNumber)).toStrictEqual([...chunks.map((c) => c.pageNumber)].toSorted((a, b) => (a ?? 0) - (b ?? 0)));
        expect(new Set(chunks.map((c) => c.pageNumber))).toStrictEqual(new Set([1, 2, 3]));
    });

    it("reports no page for text without markers", () => {
        expect(chunkText("just text\n\nmore text", MARKDOWN)).toStrictEqual([{ content: "just text\n\nmore text", index: 0 }]);
    });

    it("returns no chunks for text that is only markers", () => {
        expect(chunkText("<!-- PAGE 1 -->\n\n<!-- PAGE 2 -->", MARKDOWN)).toStrictEqual([]);
    });

    it("keeps a heading that ends a page with the section after it", () => {
        const chunks = chunkText("<!-- PAGE 1 -->\n\n# Title\n\n<!-- PAGE 2 -->\n\n## Next\n\nbody", MARKDOWN);

        expect(chunks).toStrictEqual([{ content: "# Title\n\n## Next\n\nbody", index: 0, pageNumber: 1, sectionHeading: "Title > Next" }]);
    });

    it("leaves page markers and headings in the text unless asked to read Markdown", () => {
        const text = "<!-- PAGE 1 -->\n\n# Title\n\nbody";

        expect(chunkText(text)).toStrictEqual([{ content: text, index: 0 }]);
    });

    it("matches the marker the document parser writes", () => {
        // The format string in shape.rs is the contract: the chunker must read the line it produces.
        const shape = readFileSync(join(import.meta.dirname, "../../../services/document-parser/src/shape.rs"), "utf8");
        const written = WRITTEN_MARKER_RE.exec(shape)?.[1];

        expect(written).toBeDefined();

        const marker = (written ?? "").replace("{number}", "7");

        expect(chunkText(`${marker}\n\nbody`, MARKDOWN)).toStrictEqual([{ content: "body", index: 0, pageNumber: 7 }]);
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
