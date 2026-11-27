/**
 * Reading an EPUB for the preview: a small book built here is parsed by the real parser, its chapters come in reading order (the spine's,
 * not the manifest's or the file names'), and a chapter becomes a document for a frame that can load nothing.
 */
// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chapterDocument, FRAME_POLICY, inlineBlobUrls, MAX_INLINED_CHARS, openEpub } from "./epub-book";

const REFRESH = /refresh/iu;
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

describe("chapterDocument", () => {
    it("carries the policy that refuses every request but inline styles and data pictures, and opens no link in the frame", () => {
        const document = chapterDocument("<p>text</p>", ["p{color:red}"]);

        expect(document).toContain(`content="${FRAME_POLICY}"`);
        expect(FRAME_POLICY).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
        expect(document).toContain('<base target="_blank">');
        expect(document).toContain("<style>p{color:red}</style>");
        expect(document).toContain("<body><p>text</p></body>");
        // The policy comes before anything the chapter can add.
        expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<p>text</p>"));
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

            return new Response(new Blob(["abc"], { type: "image/png" }));
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
    it("stops inlining once the budget is spent, so a repeated address cannot grow the document without bound", async () => {
        vi.stubGlobal("fetch", async () => new Response(new Blob(["x".repeat(300)], { type: "image/png" })));

        try {
            const text = '<img src="blob:https://app/big">'.repeat(10);
            // Room for three of the ~420-character data addresses.
            const result = await inlineBlobUrls(text, undefined, { left: 1300 });

            expect(result.match(/data:image\/png/gu)).toHaveLength(3);
            expect(result.match(/blob:https:\/\/app\/big/gu)).toHaveLength(7);
            expect(MAX_INLINED_CHARS).toBeGreaterThan(1_000_000);
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
