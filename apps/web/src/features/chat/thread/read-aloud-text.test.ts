import { describe, expect, it } from "vitest";

import { splitForSpeech, toSpeakableText } from "./read-aloud-text";

describe(toSpeakableText, () => {
    it("drops fenced code blocks", () => {
        expect(toSpeakableText("Run this:\n\n```ts\nconst a = 1;\n```\n\nThen done.")).toBe("Run this: Then done.");
    });

    it("drops an unterminated code block at the end", () => {
        expect(toSpeakableText("Intro\n\n```js\nconsole.log(1)")).toBe("Intro.");
    });

    it("keeps link text and image alt text", () => {
        expect(toSpeakableText("See [the docs](https://x.dev) ![logo](a.png) now ![](b.png)")).toBe("See the docs logo now.");
    });

    it("strips headings, list markers, emphasis and inline code", () => {
        expect(toSpeakableText("# Title\n\n- **bold** item\n- `code` item\n1. *one*")).toBe("Title. bold item code item one.");
    });

    it("leaves bracketed text that is not a link", () => {
        expect(toSpeakableText("see [x] and [y](u) or [z]")).toBe("see [x] and y or [z].");
    });

    it("strips table syntax", () => {
        expect(toSpeakableText("| a | b |\n| --- | :-: |\n| 1 | 2 |")).toBe("a b 1 2.");
    });

    it("drops display math and horizontal rules", () => {
        expect(toSpeakableText("Before\n\n$$\nx^2\n$$\n\n---\n\nAfter")).toBe("Before. After.");
    });

    it("strips HTML tags and blockquotes", () => {
        expect(toSpeakableText("> quoted <br/> text")).toBe("quoted text.");
    });

    it("keeps snake_case identifiers intact", () => {
        expect(toSpeakableText("use my_var here")).toBe("use my_var here.");
    });
});

describe(splitForSpeech, () => {
    it("keeps short text as one chunk", () => {
        expect(splitForSpeech("Hello there. How are you?")).toStrictEqual(["Hello there. How are you?"]);
    });

    it("breaks at sentence boundaries", () => {
        expect(splitForSpeech("One two. Three four. Five six.", 12)).toStrictEqual(["One two.", "Three four.", "Five six."]);
    });

    it("breaks an overlong sentence at word boundaries", () => {
        const chunks = splitForSpeech("alpha beta gamma delta epsilon", 12);

        expect(chunks).toStrictEqual(["alpha beta", "gamma delta", "epsilon"]);
        expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    });

    it("returns nothing for empty text", () => {
        expect(splitForSpeech("")).toStrictEqual([]);
    });
});
