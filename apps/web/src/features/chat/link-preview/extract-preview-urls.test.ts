import { describe, expect, it } from "vitest";

import { extractPreviewUrls, hasHttpUrl } from "./extract-preview-urls";

describe(extractPreviewUrls, () => {
    it("finds bare, autolinked and markdown links and trims punctuation", () => {
        const text = "See https://example.com/a. Also <https://example.org/b> and [the PR](https://github.com/o/r/pull/1), (or https://x.dev/c).";

        expect(extractPreviewUrls(text, { max: 10 })).toStrictEqual([
            "https://example.com/a",
            "https://example.org/b",
            "https://github.com/o/r/pull/1",
            "https://x.dev/c",
        ]);
    });

    it("keeps balanced parentheses inside a URL", () => {
        expect(extractPreviewUrls("https://en.wikipedia.org/wiki/Foo_(bar)")).toStrictEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    });

    it("ignores code, images, credentials and excluded origins", () => {
        const text = [
            "```\nhttps://in-fence.example/\n```",
            "`https://inline.example/`",
            "![img](https://cdn.example/pic.png)",
            "https://user:pw@secret.example/",
            "https://app.neore.test/chat/1",
            "https://kept.example/",
        ].join("\n");

        expect(extractPreviewUrls(text, { excludeOrigins: ["https://app.neore.test"] })).toStrictEqual(["https://kept.example/"]);
    });

    it("dedupes by URL without fragment and caps the count", () => {
        const text = "https://a.example/#x https://a.example/#y https://b.example/ https://c.example/ https://d.example/";

        expect(extractPreviewUrls(text)).toStrictEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    });
});

describe(hasHttpUrl, () => {
    it("is a cheap substring check", () => {
        expect(hasHttpUrl("no links here")).toBe(false);
        expect(hasHttpUrl("go to https://x")).toBe(true);
    });
});
