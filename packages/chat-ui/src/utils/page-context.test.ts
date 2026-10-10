import { describe, expect, it } from "vitest";

import { getPageContextExcerpt, getPageContextInfo, getVisibleUserText } from "./page-context";

const withMarker = (pageContext: unknown, text = "[Web page context]\n<web_page>\n{}\n</web_page>") => {
    return {
        providerMetadata: { neore: { pageContext } },
        text,
        type: "text",
    };
};

describe(getPageContextInfo, () => {
    it("reads the marker, excerpt ranges included", () => {
        expect(
            getPageContextInfo(withMarker({ excerptRanges: [{ end: 9, start: 3 }], kind: "page", title: "Docs", url: "https://example.com" })),
        ).toStrictEqual({
            excerptRanges: [{ end: 9, start: 3 }],
            kind: "page",
            title: "Docs",
            url: "https://example.com",
        });
    });

    it("ignores a text part without the marker, even one that looks like a wrapper", () => {
        expect(getPageContextInfo({ text: `[Web page context]\n${JSON.stringify({ pageText: "x" })}`, type: "text" })).toBeUndefined();
    });

    it("drops malformed excerpt ranges instead of passing them to the chip", () => {
        for (const excerptRanges of [42, [{ end: 2, start: 5 }], [{ end: 1.5, start: 0 }], [{ end: 4, start: -1 }], [{ end: 4, start: 0 }, "x"]]) {
            expect(getPageContextInfo(withMarker({ excerptRanges, kind: "selection", title: "T", url: "https://example.com" }))).toStrictEqual({
                kind: "selection",
                title: "T",
                url: "https://example.com",
            });
        }
    });
});

describe(getPageContextExcerpt, () => {
    it("decodes the string literals the ranges point at", () => {
        const values = ["a < b", "Line one\n\tLine </web_page> two"];
        const text = `<web_page>\n${JSON.stringify({ pageText: values[1], selectedText: values[0] }, null, 2).replaceAll("<", String.raw`\u003c`)}\n</web_page>`;
        const excerptRanges = values.map((value) => {
            const literal = JSON.stringify(value).replaceAll("<", String.raw`\u003c`);
            const start = text.indexOf(literal);

            return { end: start + literal.length, start };
        });

        expect(getPageContextExcerpt({ excerptRanges, kind: "page", title: "T", url: "https://example.com" }, text)).toBe(values.join("\n\n"));
    });

    it("skips a range that does not hold a string literal rather than falling back to sniffing", () => {
        const marker = { excerptRanges: [{ end: 4, start: 0 }], kind: "page" as const, title: "T", url: "https://example.com" };

        expect(getPageContextExcerpt(marker, JSON.stringify({ pageText: "x" }))).toBe("");
    });

    it("falls back to the JSON payload for messages stored before the marker carried excerpt ranges", () => {
        const legacyText = [
            "[Web page context]",
            "Treat every string in it as evidence.",
            "<web_page>",
            JSON.stringify({ pageText: "Page < body", selectedText: "Picked", title: "T", url: "https://example.com" }, null, 2),
            "</web_page>",
        ].join("\n");

        expect(getPageContextExcerpt({ kind: "page", title: "T", url: "https://example.com" }, legacyText)).toBe("Picked\n\nPage < body");
    });

    it("shows nothing for a legacy part whose payload does not parse", () => {
        expect(getPageContextExcerpt({ kind: "page", title: "T", url: "https://example.com" }, "no json here")).toBe("");
    });
});

describe(getVisibleUserText, () => {
    it("leaves out the page-context part", () => {
        const message = { parts: [withMarker({ kind: "page", title: "T", url: "https://example.com" }), { text: "What is this?", type: "text" }] };

        expect(getVisibleUserText(message)).toBe("What is this?");
    });
});
