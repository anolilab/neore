import { describe, expect, it } from "vitest";

import { extractLastCodeBlock, markdownToPlainText } from "./markdown-text";

describe("markdownToPlainText", () => {
    it("drops heading markers and keeps the text", () => {
        expect(markdownToPlainText("# Title\n\n### Sub heading ###")).toBe("Title\n\nSub heading");
    });

    it("removes emphasis, strikethrough and keeps the words", () => {
        expect(markdownToPlainText("This is **bold**, *soft*, _under_ and ~~gone~~.")).toBe("This is bold, soft, under and gone.");
    });

    it("keeps link text and image alt text, drops urls", () => {
        expect(markdownToPlainText("See [the docs](https://example.com/a_b) and ![logo](/x.png)")).toBe("See the docs and logo");
    });

    it("leaves brackets that are not links alone", () => {
        expect(markdownToPlainText("[a] b and [c](d) and [unclosed")).toBe("[a] b and c and [unclosed");
    });

    it("keeps autolink urls", () => {
        expect(markdownToPlainText("Mail <https://example.com> now")).toBe("Mail https://example.com now");
    });

    it("keeps bullets and ordered numbers, including nested indentation", () => {
        expect(markdownToPlainText("- one\n  - nested\n* two\n\n1. first\n2) second")).toBe("• one\n  • nested\n• two\n\n1. first\n2) second");
    });

    it("keeps fenced code verbatim without the fences or markup inside it", () => {
        const markdown = "Run:\n```bash\necho **not bold** [x](y)\n```\nDone";

        expect(markdownToPlainText(markdown)).toBe("Run:\necho **not bold** [x](y)\nDone");
    });

    it("keeps tilde fences and does not close on a shorter marker", () => {
        expect(markdownToPlainText("~~~~\n```\nstill code\n~~~~\nafter")).toBe("```\nstill code\nafter");
    });

    it("keeps inline code verbatim", () => {
        expect(markdownToPlainText("Call `**raw**` or ``a `b` c`` now")).toBe("Call **raw** or a `b` c now");
    });

    it("leaves snake_case and dunder identifiers alone", () => {
        expect(markdownToPlainText("Use snake_case_name and __init__ here")).toBe("Use snake_case_name and __init__ here");
    });

    it("strips dunder emphasis that has a space inside", () => {
        expect(markdownToPlainText("A __strong phrase__ here")).toBe("A strong phrase here");
    });

    it("keeps multiplication stars between digits", () => {
        expect(markdownToPlainText("2*3*4 = 24")).toBe("2*3*4 = 24");
    });

    it("turns table rows into tab-separated cells and drops the separator", () => {
        expect(markdownToPlainText("| Name | Qty |\n|:-----|----:|\n| **apple** | 2 |")).toBe("Name\tQty\napple\t2");
    });

    it("drops horizontal rules and strips blockquote markers", () => {
        expect(markdownToPlainText("above\n\n---\n\n> quoted **text**")).toBe("above\n\nquoted text");
    });

    it("unescapes markdown escapes", () => {
        expect(markdownToPlainText(String.raw`\*not emphasis\* and 1\. item`)).toBe("*not emphasis* and 1. item");
    });

    it("returns an empty string for empty input", () => {
        expect(markdownToPlainText("")).toBe("");
    });
});

describe("extractLastCodeBlock", () => {
    it("returns null when there is no fenced block", () => {
        expect(extractLastCodeBlock("just prose, `inline` only")).toBeNull();
    });

    it("returns the body of the last block, without fences or language", () => {
        const markdown = "```ts\nconst a = 1;\n```\ntext\n```python\nprint('b')\nprint('c')\n```\n";

        expect(extractLastCodeBlock(markdown)).toBe("print('b')\nprint('c')");
    });

    it("returns a block still open at the end (streaming reply)", () => {
        expect(extractLastCodeBlock("```js\nlet x = 1;")).toBe("let x = 1;");
    });

    it("returns an empty body for an empty block", () => {
        expect(extractLastCodeBlock("```\n```")).toBe("");
    });
});
