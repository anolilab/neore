import JsZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildDocumentXml, buildDocx, escapeXml } from "./docx";

const byName = (a: string, b: string): number => a.localeCompare(b);

const content = {
    date: "10/19/26, 5:32 PM",
    entries: [
        { role: "User", text: "Is 1 < 2 & 3 > 2?" },
        { role: "Assistant", text: "Yes.\nBoth hold." },
    ],
    title: "Math <check>",
};

describe(escapeXml, () => {
    it("escapes markup and drops characters XML cannot carry", () => {
        expect(escapeXml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
        expect(escapeXml("bell\u{7} tab\t")).toBe("bell tab\t");
    });
});

describe(buildDocumentXml, () => {
    it("writes the title, the date and a bold label per message", () => {
        const xml = buildDocumentXml(content);

        expect(xml).toContain("Math &lt;check&gt;");
        expect(xml).toContain("10/19/26, 5:32 PM");
        expect(xml).toContain('<w:b/></w:rPr><w:t xml:space="preserve">Assistant</w:t>');
    });

    it("keeps message text as text, never as markup", () => {
        expect(buildDocumentXml(content)).toContain("Is 1 &lt; 2 &amp; 3 &gt; 2?");
    });

    it("splits a message into one paragraph per line", () => {
        const xml = buildDocumentXml(content);

        expect(xml).toContain(">Yes.</w:t>");
        expect(xml).toContain(">Both hold.</w:t>");
    });
});

describe(buildDocx, () => {
    it("is a zip with the three parts Word needs", async () => {
        const bytes = await buildDocx(JsZip, content);
        const zip = await JsZip.loadAsync(bytes);

        expect(
            Object.keys(zip.files)
                .filter((name) => !name.endsWith("/"))
                .toSorted(byName),
        ).toStrictEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"].toSorted(byName));
        expect(await zip.file("word/document.xml")?.async("string")).toContain("Both hold.");
    });
});
