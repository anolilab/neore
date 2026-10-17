import { describe, expect, it } from "vitest";

import { formatTelegramMessage } from "./telegram-format";

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
        const chunks = formatTelegramMessage(Array.from({ length: 20 }, () => paragraph).join("\n\n"), 1200);

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
