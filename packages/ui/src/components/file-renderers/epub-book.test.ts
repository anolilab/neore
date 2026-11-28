/**
 * Reading an EPUB for the preview: a small book built here is parsed by the real parser and read from its archive. Its chapters come in
 * reading order (the spine's, not the manifest's or the file names'), a chapter's pictures and styles become `data:` URLs and inert text with
 * no object URL made, and the document a chapter becomes carries the policy first and leaves nothing that can reach beyond it.
 */
// @vitest-environment jsdom

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { chapterDocument, FRAME_POLICY, MAX_ASSETS_PER_CHAPTER, MAX_CHAPTER_CHARS, openEpub, safeStylesheet } from "./epub-book";

const PNG_PREFIX = /^data:image\/png;base64,/u;
const PNG_DATA = /^data:image\/png;base64,iVBORw0KGgo=$/u;
const TRACKER = /tracker\.example/u;
const SCRIPTY = /expression\s*\(|behaviou?r\s*:|-moz-binding\s*:/iu;
const NS = 'xmlns="http://www.idpf.org/2007/opf"';
const CONTAINER =
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface SampleChapter {
    body: string;
    file: string;
    head?: string;
    id: string;
    label?: string;
    /** The whole file, when it is not an XHTML page around `body`; and its media type in the manifest. */
    raw?: string;
    /** The name the file is stored under in the archive, when it is not the one the manifest writes. */
    stored?: string;
    type?: string;
}

interface SampleOptions {
    chapters: SampleChapter[];
    files?: Record<string, Uint8Array | string>;
    language?: string;
}

/** A book with `chapters` in the given reading order (the manifest lists them in the order given too, the spine as `chapters` says). */
const book = async ({ chapters, files = {}, language = "en" }: SampleOptions): Promise<Uint8Array> => {
    const zip = new JSZip();

    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", CONTAINER);
    zip.file(
        "OEBPS/content.opf",
        `<?xml version="1.0"?><package ${NS} version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">sample</dc:identifier><dc:title>Sample</dc:title><dc:language>${language}</dc:language></metadata>` +
            `<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${chapters.map((chapter) => `<item id="${chapter.id}" href="${chapter.file}" media-type="${chapter.type ?? "application/xhtml+xml"}"/>`).join("")}</manifest>` +
            `<spine toc="ncx">${chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("")}</spine></package>`,
    );
    zip.file(
        "OEBPS/toc.ncx",
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="sample"/></head><docTitle><text>Sample</text></docTitle><navMap>' +
            `${chapters
                // The parser needs at least one entry in the table of contents: the first chapter gets one when the sample names none.
                .map((chapter, order) => (order === 0 && chapters.every((other) => other.label === undefined) ? { ...chapter, label: "Start" } : chapter))
                .filter((chapter) => chapter.label !== undefined)
                .map(
                    (chapter, order) =>
                        `<navPoint id="n${String(order)}" playOrder="${String(order + 1)}"><navLabel><text>${chapter.label}</text></navLabel><content src="${chapter.file}"/></navPoint>`,
                )
                .join("")}</navMap></ncx>`,
    );

    for (const chapter of chapters) {
        zip.file(
            `OEBPS/${chapter.stored ?? chapter.file}`,
            chapter.raw ??
                `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>${chapter.head ?? ""}</head><body>${chapter.body}</body></html>`,
        );
    }

    for (const [path, content] of Object.entries(files)) {
        zip.file(`OEBPS/${path}`, content);
    }

    return await zip.generateAsync({ type: "uint8array" });
};

const parse = (markup: string): Document => new DOMParser().parseFromString(markup, "text/html");

const folder = { path: "" };

beforeAll(async () => {
    folder.path = await mkdtemp(join(tmpdir(), "neore-epub-"));
});

afterAll(async () => {
    await rm(folder.path, { force: true, recursive: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("openEpub", () => {
    it("lists the chapters in the book's reading order, named from its table of contents where it names them", async () => {
        const opened = await openEpub(
            await book({
                chapters: [
                    { body: "<p>two</p>", file: "two.xhtml", id: "c2", label: "Beginning" },
                    { body: "<p>one</p>", file: "one.xhtml", id: "c1", label: "Middle" },
                    { body: "<p>three</p>", file: "three.xhtml", id: "c3" },
                ],
            }),
            folder.path,
        );

        expect(opened.chapters).toEqual([{ id: "c2", title: "Beginning" }, { id: "c1", title: "Middle" }, { id: "c3" }]);
        opened.destroy();
    });

    it("names two chapters that share a file name in different folders by their own entries, and none by a guess", async () => {
        const opened = await openEpub(
            await book({
                chapters: [
                    { body: "<p>a</p>", file: "Text/chap.xhtml", id: "a", label: "Main" },
                    { body: "<p>b</p>", file: "Appendix/chap.xhtml", id: "b", label: "Extra" },
                    { body: "<p>u</p>", file: "x/same.xhtml", id: "u" },
                    { body: "<p>v</p>", file: "y/same.xhtml", id: "v" },
                ],
                language: "fr",
            }),
            folder.path,
        );

        expect(opened.chapters).toEqual([{ id: "a", title: "Main" }, { id: "b", title: "Extra" }, { id: "u" }, { id: "v" }]);
        expect(await opened.read("a")).toContain('lang="fr"');
        opened.destroy();
        // Destroying again is harmless, and says so.
        opened.destroy();
        expect(opened.destroyed).toBe(true);
    });

    it("matches a long table of contents to a long spine without a scan of the spine for each entry", async () => {
        const chapters = Array.from({ length: 1500 }, (_item, index) => {
            return {
                body: "<p>x</p>",
                file: `Text/c${String(index)}.xhtml`,
                id: `c${String(index)}`,
                label: `Chapter ${String(index)}`,
            };
        });
        const opened = await openEpub(await book({ chapters }), folder.path);
        const started = performance.now();

        expect(opened.chapters).toHaveLength(1500);
        expect(opened.chapters[1499]).toEqual({ id: "c1499", title: "Chapter 1499" });
        expect(performance.now() - started).toBeLessThan(2000);
        opened.destroy();
    });
});

describe("reading a chapter", () => {
    it("puts a picture and a style sheet of the book into the chapter, as a data: address and as text, and makes no object URL", async () => {
        const createObjectUrl = vi.spyOn(URL, "createObjectURL");
        const opened = await openEpub(
            await book({
                chapters: [
                    {
                        body: '<link rel="stylesheet" href="../css/s.css"/><h1 class="t">Title</h1><img src="../images/p.png" alt="p"/>',
                        file: "text/one.xhtml",
                        id: "c1",
                    },
                ],
                files: { "css/s.css": ".t { color: #036; background: url(../images/p.png) } p { margin: 0 }", "images/p.png": PNG },
            }),
            folder.path,
        );
        const frame = parse(await opened.read("c1"));
        const style = [...frame.head.querySelectorAll("style")].map((element) => element.textContent).join("\n");

        expect(frame.querySelector("img")?.getAttribute("src")).toMatch(PNG_DATA);
        expect(style).toContain(".t { color: #036;");
        expect(style).toContain('url("data:image/png;base64,iVBORw0KGgo=")');
        expect(createObjectUrl).not.toHaveBeenCalled();
        opened.destroy();
    });

    it("does not give one book's pictures to another that names the same file", async () => {
        const first = await openEpub(
            await book({ chapters: [{ body: '<img src="images/cover.png"/>', file: "one.xhtml", id: "c1" }], files: { "images/cover.png": PNG } }),
            folder.path,
        );
        const second = await openEpub(
            await book({
                chapters: [{ body: '<img src="images/cover.png"/>', file: "one.xhtml", id: "c1" }],
                files: { "images/cover.png": new Uint8Array([1, 2, 3, 4]) },
            }),
            folder.path,
        );
        const firstSource = parse(await first.read("c1"))
            .querySelector("img")
            ?.getAttribute("src");
        const secondSource = parse(await second.read("c1"))
            .querySelector("img")
            ?.getAttribute("src");

        // Each chapter shows its own book's bytes, whichever was opened or closed first.
        first.destroy();
        expect(secondSource).toBe("data:image/png;base64,AQIDBA==");
        expect(firstSource).toBe("data:image/png;base64,iVBORw0KGgo=");
        expect(
            parse(await second.read("c1"))
                .querySelector("img")
                ?.getAttribute("src"),
        ).toBe(secondSource);
        second.destroy();
    });

    it("leaves the chapter's text, scripts included, for the frame to refuse", async () => {
        const opened = await openEpub(
            await book({ chapters: [{ body: "<p>kept</p><script>window.ran = 1</script>", file: "one.xhtml", id: "c1" }] }),
            folder.path,
        );
        const frame = parse(await opened.read("c1"));

        expect(frame.body.querySelector("p")?.textContent).toBe("kept");
        expect(frame.body.querySelector("script")?.textContent).toBe("window.ran = 1");
        opened.destroy();
    });

    it("leaves out what is past the count of files one chapter may inline, and keeps the first", async () => {
        const pictures = Object.fromEntries(
            Array.from({ length: MAX_ASSETS_PER_CHAPTER + 5 }, (_item, index) => [`images/${String(index)}.png`, PNG] as const),
        );
        const body = Object.keys(pictures)
            .map((path) => `<img src="${path}"/>`)
            .join("");
        const opened = await openEpub(await book({ chapters: [{ body, file: "one.xhtml", id: "c1" }], files: pictures }), folder.path);
        const sources = [...parse(await opened.read("c1")).querySelectorAll("img")].map((image) => image.getAttribute("src"));

        expect(sources.filter((source) => source?.startsWith("data:image/png"))).toHaveLength(MAX_ASSETS_PER_CHAPTER);
        // What is left out is left without an address: the frame is not asked for it.
        expect(sources.filter((source) => source === null)).toHaveLength(5);
        opened.destroy();
    });

    it("leaves out a picture that will not fit what is left of the chapter's budget, without encoding it", async () => {
        const big = new Uint8Array(12 * 1024 * 1024).fill(7);
        const opened = await openEpub(
            await book({
                chapters: [{ body: '<img src="a.png"/><img src="b.png"/><p>text</p>', file: "one.xhtml", id: "c1" }],
                files: { "a.png": big, "b.png": big },
            }),
            folder.path,
        );
        const frame = parse(await opened.read("c1"));
        const sources = [...frame.querySelectorAll("img")].map((image) => image.getAttribute("src"));

        // The first (about 16 million characters as data) fits; the second would pass 24 million.
        expect(sources[0]?.startsWith("data:image/png;base64,")).toBe(true);
        expect(sources[1]).toBeNull();
        expect(frame.querySelector("p")?.textContent).toBe("text");
        opened.destroy();
    });
});

describe("a picture used many times", () => {
    it("is charged for every copy the chapter carries, and the budget stops the copies it cannot hold", async () => {
        const picture = new Uint8Array(5 * 1024 * 1024).fill(9);
        const body = '<img src="p.png"/>'.repeat(6);
        const opened = await openEpub(await book({ chapters: [{ body, file: "one.xhtml", id: "c1" }], files: { "p.png": picture } }), folder.path);
        const document = await opened.read("c1");
        const sources = [...parse(document).querySelectorAll("img")].map((image) => image.getAttribute("src"));

        // About 7 million characters a copy: three fit in 24 million, the rest are left without an address.
        expect(sources.filter((source) => source?.startsWith("data:image/png"))).toHaveLength(3);
        expect(sources.filter((source) => source === null)).toHaveLength(3);
        opened.destroy();
    });
});

describe("a chapter's style sheets", () => {
    const sheetsOf = (frame: Document): string[] => [...frame.head.querySelectorAll("style")].slice(1).map((element) => element.textContent ?? "");
    const links = (names: string[]) => names.map((name) => `<link rel="stylesheet" href="${name}"/>`).join("");

    it("keeps every sheet of a chapter within the budget, each as it is", async () => {
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["a.css", "b.css", "c.css"])}<p>x</p>`, file: "one.xhtml", id: "c1" }],
                files: { "a.css": "p{color:red}", "b.css": "p{margin:0}", "c.css": "p{padding:0}" },
            }),
            folder.path,
        );

        const document = await opened.read("c1");

        expect(sheetsOf(parse(document))).toEqual(["p{color:red}", "p{margin:0}", "p{padding:0}"]);
        opened.destroy();
    });

    it("stops at the count of files a chapter may read: the sheets past it are not read or included", async () => {
        const files = Object.fromEntries(
            Array.from({ length: MAX_ASSETS_PER_CHAPTER + 5 }, (_item, index) => [`s${String(index)}.css`, `p{order:${String(index)}}`] as const),
        );
        const chapters = [{ body: `${links(Object.keys(files))}<p>x</p>`, file: "one.xhtml", id: "c1" }];
        const opened = await openEpub(await book({ chapters, files }), folder.path);
        const document = await opened.read("c1");
        const sheets = sheetsOf(parse(document));

        expect(sheets).toHaveLength(MAX_ASSETS_PER_CHAPTER);
        expect(sheets[0]).toBe("p{order:0}");
        expect(sheets.at(-1)).toBe(`p{order:${String(MAX_ASSETS_PER_CHAPTER - 1)}}`);
        opened.destroy();
    });

    it("leaves out whole a sheet that does not fit, and reads no further sheet once one was refused", async () => {
        const big = "a{}".repeat(5_000_000);
        const fileSpy = vi.spyOn(JSZip.prototype, "file");

        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["small.css", "big1.css", "big2.css", "big3.css", "after.css"])}<p>x</p>`, file: "one.xhtml", id: "c1" }],
                files: { "after.css": "p{after:1}", "big1.css": big, "big2.css": big, "big3.css": big, "small.css": "p{small:1}" },
            }),
            folder.path,
        );

        fileSpy.mockClear();

        const document = await opened.read("c1");
        const sheets = sheetsOf(parse(document));

        // 15 million characters fit; the second would pass the 24 million, so it is left out entire. No sheet after it is opened.
        expect(sheets.map((sheet) => sheet.length)).toEqual(["p{small:1}".length, big.length]);
        const read = fileSpy.mock.calls.map((call) => String(call[0]));

        expect(read.some((path) => path.endsWith("big3.css"))).toBe(false);
        expect(read.some((path) => path.endsWith("after.css"))).toBe(false);
        opened.destroy();
    });

    it("keeps a rule the chapter defines in its head, rewritten like the other sheets", async () => {
        const chapters = [
            {
                body: "<p>x</p>",
                file: "one.xhtml",
                head: '<style>p { white-space: pre-wrap } @import url("https://evil.example/a.css"); i { background: url(https://evil.example/b.png) } </style>',
                id: "c1",
            },
        ];
        const opened = await openEpub(await book({ chapters }), folder.path);
        const document = await opened.read("c1");
        const sheets = sheetsOf(parse(document));

        expect(sheets.join("")).toContain("p { white-space: pre-wrap }");
        expect(sheets.join("")).not.toContain("evil.example");
        expect(sheets.join("")).not.toContain("@import");
        opened.destroy();
    });

    it("charges a picture a style sheet repeats for every occurrence, and stops writing it once the budget is spent", async () => {
        const picture = new Uint8Array(5 * 1024 * 1024).fill(3);
        const css = Array.from({ length: 8 }, (_item, index) => `.a${String(index)}{background:url(images/big.png)}`).join("\n");
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../s.css"])}<p>x</p>`, file: "text/one.xhtml", id: "c1" }],
                files: { "images/big.png": picture, "s.css": css },
            }),
            folder.path,
        );
        const document = await opened.read("c1");
        const sheet = sheetsOf(parse(document)).join("");

        // About 7 million characters an occurrence: three fit in 24 million; the others are left without an address, never written.
        expect(sheet.match(/url\("data:image\/png/gu)).toHaveLength(3);
        expect(sheet.match(/url\(""\)/gu)).toHaveLength(5);
        expect(sheet.length).toBeLessThan(24 * 1024 * 1024);
        opened.destroy();
    });

    it("refuses a sheet too big for what is left before it is read or rewritten, and still rewrites one that fits", async () => {
        const probe = new JSZip();

        probe.file("a", "x");

        const prototype = Object.getPrototypeOf(probe.file("a")) as { async: (...args: unknown[]) => Promise<unknown> };
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../fits.css", "../huge.css", "../after.css"])}<p>x</p>`, file: "text/one.xhtml", id: "c1" }],
                files: {
                    "after.css": "p{after:1}",
                    "fits.css": ".t{background:url(images/p.png)}",
                    "huge.css": "a{}".repeat(9_000_000),
                    "images/p.png": PNG,
                },
            }),
            folder.path,
        );
        const asyncSpy = vi.spyOn(prototype, "async");
        const document = await opened.read("c1");
        const names = asyncSpy.mock.instances.map((entry) => (entry as unknown as { name: string }).name);
        const sheets = sheetsOf(parse(document));

        expect(names.some((name) => name.endsWith("huge.css"))).toBe(false);
        expect(names.some((name) => name.endsWith("after.css"))).toBe(false);
        expect(sheets).toHaveLength(1);
        expect(sheets[0]).toContain('url("data:image/png;base64,');
        opened.destroy();
    });

    it("charges a sheet for the text it becomes once cleaned: a sheet of < stops at the budget and the document never passes it", async () => {
        const limit = 24 * 1024 * 1024;
        // Each `<` is written as four characters: 5 million of them are 20 million, 7 million would be 28.
        const fits = "<".repeat(5_000_000);
        const tooBig = "<".repeat(7_000_000);
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../fits.css", "../big.css"])}<p>x</p>`, file: "text/one.xhtml", id: "c1" }],
                files: { "big.css": tooBig, "fits.css": fits },
            }),
            folder.path,
        );
        const document = await opened.read("c1");
        const sheets = sheetsOf(parse(document));

        expect(sheets).toHaveLength(1);
        expect(sheets[0]?.length).toBe(20_000_000);
        expect(document.length).toBeLessThan(limit);
        opened.destroy();
    });

    it("leaves the head's own style as cleaned once: it is not made longer again by the document", () => {
        const css = "p{content:'<<<<'}";
        const safe = safeStylesheet(css);

        expect(safeStylesheet(safe)).toBe(safe);
        expect(parse(chapterDocument("<p>x</p>", [safe])).head.querySelectorAll("style")[1]?.textContent).toBe(safe);
    });

    it("keeps an imported rule at the import's position, from a file of the archive only", async () => {
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../main.css"])}<p>x</p>`, file: "text/one.xhtml", id: "c1" }],
                files: {
                    "base.css": ".b{color:blue} .bg{background:url(images/p.png)}",
                    "images/p.png": PNG,
                    "main.css": '.a{margin:0} @import "base.css"; @import url("https://evil.example/r.css"); @import "missing.css"; .c{padding:0}',
                },
            }),
            folder.path,
        );
        const sheet = sheetsOf(parse(await opened.read("c1"))).join("");

        expect(sheet.indexOf(".a{margin:0}")).toBeLessThan(sheet.indexOf(".b{color:blue}"));
        expect(sheet.indexOf(".b{color:blue}")).toBeLessThan(sheet.indexOf(".c{padding:0}"));
        expect(sheet).toContain('url("data:image/png;base64,');
        expect(sheet).not.toContain("evil.example");
        expect(sheet).not.toContain("@import");
        opened.destroy();
    });

    it("ends an import cycle", async () => {
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../a.css"])}<p>x</p>`, file: "text/one.xhtml", id: "c1" }],
                files: { "a.css": '@import "b.css"; .a{x:1}', "b.css": '@import "a.css"; .b{x:1}' },
            }),
            folder.path,
        );
        const sheet = sheetsOf(parse(await opened.read("c1"))).join("");

        expect(sheet).toContain(".a{x:1}");
        expect(sheet).toContain(".b{x:1}");
        expect(sheet.match(/\.a\{x:1\}/gu)).toHaveLength(1);
        opened.destroy();
    });

    it("walks linked and inline styles in source order, so a later rule wins as in the source", async () => {
        const opened = await openEpub(
            await book({
                chapters: [
                    {
                        body: "<p>x</p>",
                        file: "text/one.xhtml",
                        head: '<style>p{color:red}</style><link rel="stylesheet" href="../l.css"/><style>p{color:green}</style>',
                        id: "c1",
                    },
                ],
                files: { "l.css": "p{color:blue}" },
            }),
            folder.path,
        );

        const document = await opened.read("c1");

        expect(sheetsOf(parse(document))).toEqual(["p{color:red}", "p{color:blue}", "p{color:green}"]);
        opened.destroy();
    });

    it("does not let a rejected sheet that repeats a picture use up the room a later picture needs", async () => {
        const picture = new Uint8Array(5 * 1024 * 1024).fill(5);
        const repeated = ".a{background:url(images/big.png)}".repeat(5) + "<".repeat(2_000_000);
        const opened = await openEpub(
            await book({
                chapters: [{ body: `${links(["../rejected.css"])}<img src="../images/big.png"/>`, file: "text/one.xhtml", id: "c1" }],
                files: { "images/big.png": picture, "rejected.css": repeated },
            }),
            folder.path,
        );
        const frame = parse(await opened.read("c1"));

        // The sheet (five pictures and 8 million characters of cleaned text) does not fit and is left out; the chapter's picture still shows.
        expect(sheetsOf(frame)).toHaveLength(0);
        expect(frame.querySelector("img")?.getAttribute("src")).toMatch(PNG_PREFIX);
        opened.destroy();
    });

    it("stops doing work once a read was abandoned: a read that finishes after cancellation builds nothing further", async () => {
        const probe = new JSZip();

        probe.file("a", "x");

        const prototype = Object.getPrototypeOf(probe.file("a")) as { async: (...args: unknown[]) => Promise<unknown> };
        const pictures = Object.fromEntries(Array.from({ length: 6 }, (_item, index) => [`images/${String(index)}.png`, PNG] as const));
        const body = Object.keys(pictures)
            .map((path) => `<img src="../${path}"/>`)
            .join("");
        const opened = await openEpub(await book({ chapters: [{ body, file: "text/one.xhtml", id: "c1" }], files: pictures }), folder.path);
        const controller = new AbortController();
        const original = prototype.async;
        let reads = 0;

        const spy = vi.spyOn(prototype, "async").mockImplementation(
            // eslint-disable-next-line func-names -- wraps a prototype method, which needs its receiver
            async function (this: unknown, ...args: unknown[]) {
                reads += 1;

                // eslint-disable-next-line unicorn/no-this-outside-of-class -- the wrapped method needs its receiver
                const result = await original.apply(this, args);

                // The person leaves while the first picture is being read.
                if (reads === 2) {
                    controller.abort();
                }

                return result;
            },
        );

        await expect(opened.read("c1", controller.signal)).rejects.toThrow();
        // The chapter's own read, the first picture's read that was in flight, and no more.
        expect(reads).toBe(2);
        spy.mockRestore();
        opened.destroy();
    });

    it("starts no request while a chapter with remote resources is parsed and built: the parse runs in documents that fetch nothing", async () => {
        const fetched = vi.fn();

        vi.stubGlobal("fetch", fetched);

        try {
            const opened = await openEpub(
                await book({
                    chapters: [
                        {
                            body: '<img src="https://evil.example/a.png" srcset="https://evil.example/b.png 2x"><video poster="https://evil.example/p.png"></video>',
                            file: "one.xhtml",
                            id: "c1",
                        },
                    ],
                }),
                folder.path,
            );
            const frame = parse(await opened.read("c1"));

            expect(fetched).not.toHaveBeenCalled();
            expect(frame.documentElement.outerHTML).not.toContain("evil.example");
            opened.destroy();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("opens a book whose spine is SVG pages, in spine order", async () => {
        const svg = (label: string) => `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${label}</text></svg>`;
        const opened = await openEpub(
            await book({
                chapters: [
                    { body: "", file: "two.svg", id: "s2", label: "Second", raw: svg("two"), type: "image/svg+xml" },
                    { body: "", file: "one.svg", id: "s1", label: "First", raw: svg("one"), type: "image/svg+xml" },
                ],
            }),
            folder.path,
        );

        expect(opened.chapters.map((chapter) => chapter.id)).toEqual(["s2", "s1"]);
        expect(await opened.read("s2")).toContain("two");
        opened.destroy();
    });

    it("refuses a chapter whose own markup is larger than a chapter may be", async () => {
        const opened = await openEpub(
            await book({ chapters: [{ body: `<p>${"x".repeat(MAX_CHAPTER_CHARS)}</p>`, file: "one.xhtml", id: "c1" }] }),
            folder.path,
        );

        await expect(opened.read("c1")).rejects.toThrow("chapter too large");
        opened.destroy();
    });
});

describe("chapterDocument", () => {
    it("carries the policy as the first element of the head, before any of the chapter is written, and opens no link in the frame", () => {
        const frame = parse(chapterDocument("<p>text</p>", ["p{color:red}"]));
        const policy = frame.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');

        expect(FRAME_POLICY).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'");
        expect(policy).toHaveLength(1);
        expect(policy[0]?.getAttribute("content")).toBe(FRAME_POLICY);
        expect(frame.head.firstElementChild).toBe(policy[0]);
        expect([...frame.head.children].map((element) => element.tagName)).toEqual(["META", "META", "BASE", "STYLE", "STYLE"]);
        expect(frame.querySelector("base")?.getAttribute("target")).toBe("_blank");
        expect(frame.head.querySelectorAll("style")[1]?.textContent).toBe("p{color:red}");
        expect(frame.body.outerHTML).toBe("<body><p>text</p></body>");
    });

    it("writes the policy before the chapter: it comes earlier in the serialized document than any of the chapter's markup", () => {
        const text = chapterDocument('<p id="mark">text</p>', []);

        expect(text.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
        expect(text.indexOf("Content-Security-Policy")).toBeLessThan(text.indexOf('id="mark"'));
    });

    it("carries the book's language on the document, and only a well-formed one", () => {
        expect(parse(chapterDocument("<p>x</p>", [], "de-CH")).documentElement.getAttribute("lang")).toBe("de-CH");
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
        const frame = parse(chapterDocument(markup, []));

        expect([...frame.querySelectorAll("meta")].map((meta) => meta.getAttribute("http-equiv") ?? meta.getAttribute("charset"))).toEqual([
            "Content-Security-Policy",
            // eslint-disable-next-line unicorn/text-encoding-identifier-case -- the HTML label
            "utf-8",
        ]);
        expect(frame.documentElement.outerHTML).not.toMatch(TRACKER);
    });

    it("removes a remote picture, style or frame from the markup: nothing the chapter names is left to load", () => {
        const frame = parse(
            chapterDocument(
                [
                    '<img src="https://evil.example/a.png" srcset="https://evil.example/b.png 2x" alt="x">',
                    '<img src="//evil.example/c.png">',
                    '<img src="data:image/png;base64,AAAA">',
                    '<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>',
                    '<svg><image href="https://evil.example/i.png"/><use xlink:href="https://evil.example/u.svg#a"/><use href="#local"/></svg>',
                    '<iframe src="https://evil.example/"></iframe><object data="https://evil.example/o"></object><embed src="https://evil.example/e">',
                    '<link rel="stylesheet" href="https://evil.example/s.css">',
                    '<div style="background:url(https://evil.example/bg.png)">x</div>',
                    "<style>@import url(https://evil.example/i.css); p{background:url(https://evil.example/b.png)}</style>",
                    '<form action="https://evil.example/post"><input type="image" src="https://evil.example/f.png"></form>',
                ].join(""),
                [],
            ),
        );
        const html = frame.body.outerHTML;

        expect(html).not.toContain("evil.example");
        expect(frame.querySelectorAll("iframe, object, embed, link")).toHaveLength(0);
        expect(frame.querySelector('img[src^="data:image/png"]')).not.toBeNull();
        expect(frame.querySelector('use[href="#local"]')).not.toBeNull();
    });

    it("leaves no remote address of any kind in the markup a chapter becomes: srcset lists, pictures, posters, objects, templates, animations and inline styles", () => {
        const frame = parse(
            chapterDocument(
                [
                    '<img src="https://evil.example/a.png" srcset="data:image/png;base64,AAAA 1x, https://evil.example/b.png 2x" alt="x">',
                    '<picture><source srcset="https://evil.example/c.webp 1x" type="image/webp"><img srcset="https://evil.example/d.png" alt="y"></picture>',
                    '<video poster="https://evil.example/p.png"><source src="https://evil.example/v.mp4"><track src="https://evil.example/t.vtt"></video>',
                    '<object data="https://evil.example/o.swf"></object><link rel="preload" href="https://evil.example/l.css" as="style">',
                    '<p style="background:url(https://evil.example/s.png)">s</p>',
                    '<template shadowrootmode="open"><a href="https://evil.example/" target="_self">t</a></template>',
                    '<svg><a href="#x"><set attributeName="href" to="https://evil.example/"/></a><animate attributeName="href" to="https://evil.example/"/></svg>',
                ].join(""),
                [],
            ),
        );

        expect(frame.documentElement.outerHTML).not.toContain("evil.example");
        expect(frame.querySelector("template")).toBeNull();
        expect(frame.querySelectorAll("set, animate")).toHaveLength(0);
        // The one candidate that is a data address is not what was removed: a list that names anything else goes whole.
        expect(frame.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    });

    it("reads a chapter written as XHTML as XHTML: a self-closing span does not wrap what follows", async () => {
        const opened = await openEpub(
            await book({ chapters: [{ body: '<p><span id="page-3"/>after the marker</p><p>second</p>', file: "one.xhtml", id: "c1" }] }),
            folder.path,
        );
        const frame = parse(await opened.read("c1"));

        expect(frame.querySelectorAll("p")).toHaveLength(2);
        expect(frame.querySelector("span")?.textContent).toBe("");
        opened.destroy();
    });

    it("finds a chapter whose name is written with escapes, and draws an inline-style picture from the archive", async () => {
        const opened = await openEpub(
            await book({
                chapters: [
                    { body: '<div style="background-image:url(images/p.png)">x</div>', file: "my%20chapter.xhtml", id: "c1", stored: "my chapter.xhtml" },
                ],
                files: { "images/p.png": PNG },
            }),
            folder.path,
        );

        // The archive stores the file under its plain name; the picture of the inline style comes from the archive too.
        const frame = parse(await opened.read("c1"));

        expect(frame.querySelector("div")?.getAttribute("style")).toContain("data:image/png;base64,");
        opened.destroy();
    });

    it("makes every anchor's target _blank, whatever the chapter wrote, so a link cannot navigate the frame", () => {
        const frame = parse(
            chapterDocument(
                '<a href="https://example.org" target="_top">top</a><a href="x" target="_self">self</a><a href="y" target="named">named</a><a href="z">none</a><map><area href="w" target="_parent"></map>',
                [],
            ),
        );

        for (const link of frame.querySelectorAll("a, area")) {
            expect(link.getAttribute("target")).toBe("_blank");
            expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        }

        // The addresses stay: a link is not a load.
        expect(frame.querySelector("a")?.getAttribute("href")).toBe("https://example.org");
    });

    it("keeps a link to a place in the chapter (a footnote and its way back) inside the frame, whatever target it wrote", () => {
        const frame = parse(
            chapterDocument(
                '<p>text<a href="#fn1" id="ref1" target="_top">1</a></p><p id="fn1">note <a href=" #ref1" target="named">back</a></p><a href="https://example.org#x">out</a>',
                [],
            ),
        );
        const [note, back, out] = [...frame.querySelectorAll("a")];

        expect(note?.getAttribute("target")).toBe("_self");
        expect(back?.getAttribute("target")).toBe("_self");
        expect(out?.getAttribute("target")).toBe("_blank");
    });

    it("sets the document's own base so a # link resolves inside it, and leaves every other address as it was", () => {
        const frame = parse(chapterDocument('<a href="#fn1">1</a><a href="chap2.xhtml#x">2</a><a href="https://example.org/">3</a>', []));
        const hrefs = [...frame.querySelectorAll("a")].map((link) => link.getAttribute("href"));

        expect(frame.querySelector("base")?.getAttribute("href")).toBe("about:srcdoc");
        expect(frame.querySelector("base")?.getAttribute("target")).toBe("_blank");
        expect(hrefs).toEqual(["#fn1", "chap2.xhtml#x", "https://example.org/"]);
    });

    it("drops a base a chapter brings, so its links keep the frame's own", () => {
        const frame = parse(chapterDocument('<base href="https://evil.example/"><p>x</p>', []));

        expect(frame.querySelectorAll("base")).toHaveLength(1);
        // Only the frame's own base is left, and it points at the document itself.
        expect(frame.querySelector("base")?.getAttribute("href")).toBe("about:srcdoc");
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
        expect(safeStylesheet("a { width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(x.xml#b) }")).not.toMatch(SCRIPTY);
    });
});
