import { describe, expect, it } from "vitest";

import { formatTelegramMessage, splitLossless } from "./telegram-format";

const html = (markdown: string): string => formatTelegramMessage(markdown)[0]?.html ?? "";

describe("formatTelegramMessage", () => {
    it("escapes HTML in text and code", () => {
        expect(html("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
        expect(html("use `<div>` here")).toBe("use <code>&lt;div&gt;</code> here");
    });

    it("maps headings, bold, italic, bullets and links", () => {
        expect(html("# Title")).toBe("<b>Title</b>");
        expect(html("**bold** and *it*")).toBe("<b>bold</b> and <i>it</i>");
        expect(html("- one\n- two")).toBe("• one\n• two");
        expect(html("[x](https://a.test/?q=1&r=2)")).toBe('<a href="https://a.test/?q=1&amp;r=2">x</a>');
    });

    it("leaves markdown inside code untouched", () => {
        expect(html("```ts\nconst a = **b**;\n```")).toBe("<pre>const a = **b**;</pre>");
    });

    it("splits long replies at block boundaries under the limit", () => {
        const paragraph = "word ".repeat(100).trim();
        const chunks = formatTelegramMessage(`${paragraph}\n\n`.repeat(20).trimEnd(), 1200);

        expect(chunks.length).toBeGreaterThan(1);

        for (const chunk of chunks) {
            expect(chunk.html.length).toBeLessThanOrEqual(1200);
            expect(chunk.html.startsWith("word")).toBe(true);
            expect(chunk.html.endsWith("word")).toBe(true);
        }
    });

    it("keeps a code block whole, and re-fences it when it must be split", () => {
        const lines = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`);
        const chunks = formatTelegramMessage(`intro\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``, 120);

        expect(chunks.length).toBeGreaterThan(2);

        for (const chunk of chunks) {
            expect(chunk.html.length).toBeLessThanOrEqual(120);
            expect(chunk.html.includes("<pre>")).toBe(chunk.html.includes("</pre>"));
        }

        expect(chunks.map((chunk) => chunk.html).join("\n")).toContain("line 49");
    });
});

describe("splitLossless", () => {
    it("keeps every character, including the spaces at each cut", () => {
        const line = "const   value = compute(alpha,  beta,   gamma, delta, epsilon, zeta, eta, theta)";

        for (const size of [7, 16, 40]) {
            const pieces = splitLossless(line, size);

            expect(pieces.join("")).toBe(line);
            expect(pieces.every((piece) => piece.length <= size)).toBe(true);
        }
    });
});

describe("links and code in Telegram output", () => {
    it("keeps emphasis markers inside a link URL out of the markup", () => {
        const chunk = formatTelegramMessage("[x](https://example.test/?q=**a**)")[0];

        expect(chunk?.html).toBe('<a href="https://example.test/?q=**a**">x</a>');
    });

    it("keeps a balanced parenthesis in a link URL", () => {
        const chunk = formatTelegramMessage("[article](https://en.wikipedia.org/wiki/Function_(mathematics))")[0];

        expect(chunk?.html).toBe('<a href="https://en.wikipedia.org/wiki/Function_(mathematics)">article</a>');
    });

    it("never leaves an inline code span open across a split", () => {
        const line = `${"word ".repeat(30)}\`code span with spaces\` ${"tail ".repeat(20)}`;

        for (const piece of splitLossless(line, 40)) {
            expect(piece.split("`").length % 2).toBe(1);
        }
    });

    it("cuts a code span longer than a piece without adding characters", () => {
        const line = `\`${"x".repeat(120)}\``;
        const pieces = splitLossless(line, 40);

        expect(pieces.every((piece) => piece.length <= 40)).toBe(true);
        expect(pieces.join("")).toBe(line);
    });
});

describe("fenced code in Telegram output", () => {
    it("keeps the language tag on the plain-text source", () => {
        const chunk = formatTelegramMessage("```ts\nconst a = 1;\n```")[0];

        expect(chunk?.source.startsWith("```ts\n")).toBe(true);
    });
});

describe("long replies keep their line breaks", () => {
    it("joins the pieces of one paragraph with a single newline", () => {
        const paragraph = Array.from({ length: 60 }, (_, index) => `line number ${index}`).join("\n");
        const chunks = formatTelegramMessage(paragraph, 300);

        expect(chunks.length).toBeGreaterThan(1);

        for (const chunk of chunks) {
            expect(chunk.html).not.toContain("\n\n");
        }
    });
});

describe("nested fences", () => {
    it("keeps a shorter fence inside a longer code block as code", () => {
        const [chunk] = formatTelegramMessage("````\n```\nnested\n```\nstill code\n````");

        expect(chunk?.html).toContain("still code");
        expect(chunk?.html.startsWith("<pre>")).toBe(true);
        expect(chunk?.html.endsWith("</pre>")).toBe(true);
    });
});

describe("one oversized line", () => {
    it("keeps the cut parts on one line, with no blank line inside it", () => {
        const line = Array.from({ length: 800 }, (_, index) => `word${index}`).join(" ");
        const chunks = formatTelegramMessage(line, 400);

        expect(chunks.length).toBeGreaterThan(1);

        for (const chunk of chunks) {
            expect(chunk.html).not.toContain("\n\n");
            expect(chunk.source).not.toContain("\n\n");
        }

        expect(chunks.map((chunk) => chunk.source).join("")).toBe(line);
    });
});

describe("emoji in a cut line", () => {
    it("never cuts between the halves of an emoji", () => {
        const line = `${"&".repeat(681)}😀${"&".repeat(200)}`;
        const pieces = splitLossless(line, 682);

        expect(pieces.join("")).toBe(line);

        for (const piece of pieces) {
            expect(piece.isWellFormed()).toBe(true);
        }
    });
});

describe("blank lines between blocks", () => {
    it("keeps the number of blank lines a reply has between two paragraphs", () => {
        const [chunk] = formatTelegramMessage("first\n\n\nsecond");

        expect(chunk?.html).toBe("first\n\n\nsecond");
    });
});

describe("a cut line's middle", () => {
    it("does not read a piece's leading '#' as a heading", () => {
        const line = `${"word ".repeat(40)}# not a heading ${"word ".repeat(40)}`;
        const chunks = formatTelegramMessage(line, 120);
        const text = chunks.map((chunk) => chunk.source).join("");

        expect(text).toContain("# not a heading");
        expect(chunks.every((chunk) => !chunk.html.includes("<b># "))).toBe(true);
    });
});
