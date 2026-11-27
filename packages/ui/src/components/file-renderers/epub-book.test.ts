/**
 * Reading an EPUB for the preview: a small book built here is parsed by the real parser, its chapters come in reading order (the spine's,
 * not the manifest's or the file names'), and a chapter becomes a document for a frame that can load nothing.
 */
// @vitest-environment jsdom

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chapterDocument, FRAME_POLICY, inlineBlobUrls, MAX_INLINED_CHARS, openEpub, safeStylesheet } from "./epub-book";

const REFRESH = /refresh/iu;
const SCRIPTY = /expression\s*\(|behaviou?r\s*:|-moz-binding\s*:/iu;
const NS = 'xmlns="http://www.idpf.org/2007/opf"';

/** Three chapters whose reading order (two, one, three) differs from their manifest and file-name order. */
const sampleBook = async (): Promise<Uint8Array> => {
    const zip = new JSZip();

    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file(
        "META-INF/container.xml",
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    zip.file(
        "OEBPS/content.opf",
        `<?xml version="1.0"?><package ${NS} version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">sample</dc:identifier><dc:title>Sample</dc:title><dc:language>en</dc:language></metadata>` +
            '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="three.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png"/></manifest>' +
            '<spine toc="ncx"><itemref idref="c2"/><itemref idref="c1"/><itemref idref="c3"/></spine></package>',
    );
    zip.file(
        "OEBPS/toc.ncx",
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="sample"/></head><docTitle><text>Sample</text></docTitle><navMap>' +
            '<navPoint id="n2" playOrder="1"><navLabel><text>Beginning</text></navLabel><content src="two.xhtml"/></navPoint><navPoint id="n1" playOrder="2"><navLabel><text>Middle</text></navLabel><content src="one.xhtml#top"/></navPoint></navMap></ncx>',
    );

    for (const [name, heading] of [
        ["one", "Middle chapter"],
        ["two", "First chapter"],
        ["three", "Last chapter"],
    ] as const) {
        zip.file(
            `OEBPS/${name}.xhtml`,
            `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head><body><h1>${heading}</h1>${name === "three" ? "<script>window.ran = true</script>" : ""}</body></html>`,
        );
    }

    zip.file("OEBPS/cover.png", new Uint8Array([137, 80, 78, 71]));

    return await zip.generateAsync({ type: "uint8array" });
};

describe("openEpub", () => {
    let directory = "";

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "neore-epub-"));
    });

    afterAll(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it("lists the chapters in the book's reading order, named from its table of contents where it names them", async () => {
        const book = await openEpub(await sampleBook(), directory);

        expect(book.chapters).toEqual([{ id: "c2", title: "Beginning" }, { id: "c1", title: "Middle" }, { id: "c3" }]);
        book.destroy();
    });

    it("leaves a chapter's markup as it is, scripts included: the frame it is shown in is the boundary", async () => {
        const book = await openEpub(await sampleBook(), directory);
        const last = await book.read("c3");

        expect(last).toContain("<h1>Last chapter</h1>");
        expect(last).toContain("<script>window.ran = true</script>");
        book.destroy();
    });
});

const parse = (parsed: string): Document => new DOMParser().parseFromString(parsed, "text/html");

describe("chapterDocument", () => {
    it("carries the policy first in the head, ahead of anything the chapter or its styles add, and opens no link in the frame", () => {
        const parsed = parse(chapterDocument("<p>text</p>", ["p{color:red}"]));
        const policy = parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');

        expect(FRAME_POLICY).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
        expect(policy).toHaveLength(1);
        expect(policy[0]?.getAttribute("content")).toBe(FRAME_POLICY);
        expect([...parsed.head.children].map((element) => element.tagName)).toEqual(["META", "META", "BASE", "STYLE", "STYLE"]);
        // The policy precedes every style of the head.
        expect(policy[0]?.compareDocumentPosition(parsed.head.querySelector("style") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(parsed.querySelector("base")?.getAttribute("target")).toBe("_blank");
        expect(parsed.head.querySelectorAll("style")[1]?.textContent).toBe("p{color:red}");
        expect(parsed.body.outerHTML).toBe("<body><p>text</p></body>");
    });

    it("carries the book's language on the document, and only a well-formed one", () => {
        expect(parse(chapterDocument("<p>x</p>", [], "de-CH")).documentElement.getAttribute("lang")).toBe("de-CH");
        expect(parse(chapterDocument("<p>x</p>", [], "en")).documentElement.getAttribute("lang")).toBe("en");
        expect(parse(chapterDocument("<p>x</p>", [], 'en"><script>')).documentElement.hasAttribute("lang")).toBe(false);
        expect(parse(chapterDocument("<p>x</p>", [])).documentElement.hasAttribute("lang")).toBe(false);
    });

    it.each([
        ["the plain spelling", '<meta http-equiv="refresh" content="0;url=https://tracker.example/x">'],
        ["upper case and no quotes", "<META HTTP-EQUIV=Refresh CONTENT=1>"],
        ["a slash for the space", "<meta/http-equiv=refresh content=0;url=https://tracker.example/x>"],
        ["a > inside an earlier quoted value", '<meta name=">" http-equiv=refresh content="0;url=https://tracker.example/x">'],
        ["a character reference", '<meta http-equiv="&#114;efresh" content="0;url=https://tracker.example/x">'],
        ["a refresh in the middle of the text", '<p>a</p><meta http-equiv=refresh content="0;url=https://tracker.example/x"><p>b</p>'],
    ])("leaves no refresh directive from %s", (_name, markup) => {
        const parsed = parse(chapterDocument(markup, []));

        expect([...parsed.querySelectorAll("meta")].map((meta) => meta.getAttribute("http-equiv") ?? meta.getAttribute("charset"))).toEqual([
            // eslint-disable-next-line unicorn/text-encoding-identifier-case -- the HTML label
            "utf-8",
            "Content-Security-Policy",
        ]);
        expect(parsed.documentElement.outerHTML).not.toContain("tracker.example");
    });

    it("leaves the rest of the chapter's markup, links and scripts included", () => {
        const body = '<p>kept</p><a href="https://example.org" target="_self">link</a><script>window.ran = 1</script>';
        const parsed = parse(chapterDocument(body, []));

        expect(parsed.body.querySelector("p")?.textContent).toBe("kept");
        expect(parsed.body.querySelector("a")?.getAttribute("href")).toBe("https://example.org");
        expect(parsed.body.querySelector("script")?.textContent).toBe("window.ran = 1");
    });

    it("drops a base a chapter brings, so its links keep the frame's own", () => {
        const parsed = parse(chapterDocument('<base href="https://evil.example/"><p>x</p>', []));

        expect(parsed.querySelectorAll("base")).toHaveLength(1);
        expect(parsed.querySelector("base")?.getAttribute("href")).toBeNull();
    });
});

describe("a style sheet in the document", () => {
    it("cannot end its element or begin markup: no script, refresh or other element comes of it, and head and body are as without it", () => {
        const hostile = 'p{color:red}</style><script>window.ran = 1</script><meta http-equiv="refresh" content="0;url=https://tracker.example/"><style>';
        const without = parse(chapterDocument("<p>x</p>", ["p{color:blue}"]));
        const withHostile = parse(chapterDocument("<p>x</p>", [hostile]));

        expect(withHostile.querySelectorAll("script")).toHaveLength(0);
        expect([...withHostile.head.children].map((element) => element.tagName)).toEqual([...without.head.children].map((element) => element.tagName));
        expect(withHostile.body.outerHTML).toBe(without.body.outerHTML);
        expect(withHostile.querySelectorAll('meta[http-equiv="refresh"]')).toHaveLength(0);
        expect(withHostile.documentElement.outerHTML).not.toContain("tracker.example</");
        // What was written is text of the one style element, with its `<` escaped.
        expect(withHostile.head.querySelectorAll("style")[1]?.textContent).toContain(String.raw`\3c /style>`);
    });

    it("applies an ordinary sheet as it is", () => {
        const css = 'h1 { color: #036; font: 1rem/1.4 "Georgia", serif } .a > .b + .c ~ .d { margin: 0 auto } @media (min-width: 40em) { p { color: red } }';

        expect(safeStylesheet(css)).toBe(css);
        expect(parse(chapterDocument("<h1>t</h1>", [css])).head.querySelectorAll("style")[1]?.textContent).toBe(css);
    });

    it("removes an @import and any url() that is not a data: URL, and keeps a data: one", () => {
        const css =
            '@import url("https://evil.example/a.css"); @import "b.css"; a { background: url(https://evil.example/x.png) } b { background: url( \'c.png\' ) } c { background: url("data:image/png;base64,AAAA") } d { background: URL(DATA:image/png;base64,BBBB) }';
        const safe = safeStylesheet(css);

        expect(safe).not.toContain("@import");
        expect(safe).not.toContain("evil.example");
        expect(safe).not.toContain("c.png");
        expect(safe).toContain('url("data:image/png;base64,AAAA")');
        expect(safe).toContain("URL(DATA:image/png;base64,BBBB)");
        expect(safe).toContain('a { background: url("") }');
    });

    it("takes out the script-like constructs of old engines", () => {
        const safe = safeStylesheet("a { width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(x.xml#b) }");

        expect(safe).not.toMatch(SCRIPTY);
    });
});

describe("inlineBlobUrls", () => {
    it("replaces a blob address of this page by the bytes it names, and leaves one that cannot be read", async () => {
        const fetched: string[] = [];

        vi.stubGlobal("fetch", async (url: string) => {
            fetched.push(url);

            if (url === "blob:https://app/gone") {
                throw new Error("revoked");
            }

            return new Response("abc", { headers: { "content-type": "image/png" } });
        });

        try {
            const text =
                '<img src="blob:https://app/one"><img src="blob:https://app/one"><img src="blob:https://app/gone"><img src="https://other.example/x.png">';
            const result = await inlineBlobUrls(text);

            expect(result).toContain('<img src="data:image/png;base64,YWJj">');
            expect(result.match(/data:image\/png;base64,YWJj/gu)).toHaveLength(2);
            expect(result).toContain('src="blob:https://app/gone"');
            expect(result).toContain('src="https://other.example/x.png"');
            // Each address is read once, however often it appears.
            expect(fetched.filter((url) => url === "blob:https://app/one")).toHaveLength(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("chapterDocument language and refresh", () => {
    it("carries the book's language on the document, and only a well-formed one", () => {
        expect(chapterDocument("<p>x</p>", [], "de-CH")).toContain('<html lang="de-CH">');
        expect(chapterDocument("<p>x</p>", [], "en")).toContain('<html lang="en">');
        expect(chapterDocument("<p>x</p>", [], 'en"><script>')).toContain("<html><head>");
        expect(chapterDocument("<p>x</p>", [])).toContain("<html><head>");
    });

    it("takes out a refresh that would move the frame by itself, and leaves the rest of the markup", () => {
        const body =
            '<meta http-equiv="refresh" content="0;url=https://tracker.example/x"><META HTTP-EQUIV=Refresh CONTENT="1"><p>kept</p><a href="https://example.org">link</a>';
        const document = chapterDocument(body, []);

        expect(document).not.toMatch(REFRESH);
        expect(document).toContain("<p>kept</p>");
        expect(document).toContain('<a href="https://example.org">link</a>');
    });
});

describe("inlineBlobUrls budget", () => {
    const answerWith = (sizes: Record<string, number>, fetched: string[]) =>
        vi.stubGlobal("fetch", async (url: string) => {
            fetched.push(url);

            return new Response("x".repeat(sizes[url] ?? 0), { headers: { "content-type": "image/png" } });
        });

    it("counts an address as often as it appears, and does not convert one that will not fit", async () => {
        const fetched: string[] = [];

        answerWith({ "blob:https://app/big": 300, "blob:https://app/small": 30 }, fetched);

        try {
            // A data address of 30 bytes is about 70 characters; of 300, about 430.
            const text = '<img src="blob:https://app/small"><img src="blob:https://app/big"><img src="blob:https://app/big">';
            const budget = { left: 700 };
            const result = await inlineBlobUrls(text, undefined, budget);

            expect(result.match(/data:image\/png/gu)).toHaveLength(1);
            expect(result).toContain("blob:https://app/big");
            expect(budget.left).toBeGreaterThan(0);
            expect(budget.left).toBeLessThan(700);
            expect(MAX_INLINED_CHARS).toBeGreaterThan(1_000_000);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("reads the addresses one at a time, not all at once", async () => {
        let inFlight = 0;
        let peak = 0;

        vi.stubGlobal("fetch", async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Promise.resolve();
            inFlight -= 1;

            return new Response("x", { headers: { "content-type": "image/png" } });
        });

        try {
            const text = Array.from({ length: 20 }, (_item, index) => `<img src="blob:https://app/${String(index)}">`).join("");

            await inlineBlobUrls(text);
            expect(peak).toBe(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("chapter titles", () => {
    it("names two chapters that share a file name in different folders by their own table-of-contents entries, and none by a guess", async () => {
        const zip = new JSZip();

        zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
        zip.file(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        );
        zip.file(
            "OEBPS/content.opf",
            `<?xml version="1.0"?><package ${NS} version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">s</dc:identifier><dc:title>S</dc:title><dc:language>fr</dc:language></metadata>` +
                '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="Text/chap.xhtml" media-type="application/xhtml+xml"/><item id="b" href="Appendix/chap.xhtml" media-type="application/xhtml+xml"/><item id="u" href="x/same.xhtml" media-type="application/xhtml+xml"/><item id="v" href="y/same.xhtml" media-type="application/xhtml+xml"/></manifest>' +
                '<spine toc="ncx"><itemref idref="a"/><itemref idref="b"/><itemref idref="u"/><itemref idref="v"/></spine></package>',
        );
        zip.file(
            "OEBPS/toc.ncx",
            '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="s"/></head><docTitle><text>S</text></docTitle><navMap>' +
                '<navPoint id="n1" playOrder="1"><navLabel><text>Main</text></navLabel><content src="Text/chap.xhtml"/></navPoint>' +
                '<navPoint id="n2" playOrder="2"><navLabel><text>Extra</text></navLabel><content src="Appendix/chap.xhtml"/></navPoint>' +
                '<navPoint id="n3" playOrder="3"><navLabel><text>Which</text></navLabel><content src="same.xhtml"/></navPoint></navMap></ncx>',
        );

        for (const path of ["Text/chap", "Appendix/chap", "x/same", "y/same"]) {
            zip.file(
                `OEBPS/${path}.xhtml`,
                '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>text</p></body></html>',
            );
        }

        const directory = await mkdtemp(join(tmpdir(), "neore-epub-titles-"));

        try {
            const book = await openEpub(await zip.generateAsync({ type: "uint8array" }), directory);

            expect(book.chapters).toEqual([{ id: "a", title: "Main" }, { id: "b", title: "Extra" }, { id: "u" }, { id: "v" }]);
            expect(await book.read("a")).toContain('<html lang="fr">');
            book.destroy();
            // Destroying again is harmless.
            book.destroy();
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
