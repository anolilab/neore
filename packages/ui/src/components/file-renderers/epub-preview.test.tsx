// @vitest-environment jsdom

/**
 * The EPUB preview: chapters in reading order with previous and next, each in a frame that can run nothing, and a file over the size
 * cap refused before it is read.
 */

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const book = vi.hoisted(() => {
    return { opened: 0, reads: [] as string[], throwOnOpen: false };
});

// eslint-disable-next-line no-restricted-syntax -- no macro transform in this package's vitest; nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

// The parser is covered with a real book in `epub-book.test.ts`; here it is the stand-in that gives three chapters.
// eslint-disable-next-line no-restricted-syntax -- the component imports the parser's wrapper directly; nothing to inject into
vi.mock("./epub-book", () => {
    return {
        openEpub: async () => {
            book.opened += 1;

            if (book.throwOnOpen) {
                throw new Error("not a book");
            }

            return {
                chapters: [{ id: "c1", title: "Beginning" }, { id: "c2" }, { id: "c3", title: "End" }],
                destroy: () => {},
                read: async (id: string) => {
                    book.reads.push(id);

                    return `<body>chapter ${id}${id === "c2" ? "<script>window.ran = true</script>" : ""}</body>`;
                },
            };
        },
    };
});

// The zip guard looks inside a real archive; the stand-in bytes below are not one.
// eslint-disable-next-line no-restricted-syntax -- see above
vi.mock("@ui/utils/office-zip-limits", () => {
    return { assertOfficeZipWithinLimits: async () => {}, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES: 50 * 1024 * 1024 };
});

const { default: EpubPreview } = await import("./epub-preview");

const URL_OF_BOOK = "https://files.example/book.epub?sig=1";

const view = { container: undefined as unknown as HTMLDivElement, fetched: 0, root: undefined as unknown as Root };

const answer = (body: BodyInit, headers: Record<string, string> = {}) => {
    vi.stubGlobal("fetch", async () => {
        view.fetched += 1;

        return new Response(body, { headers, status: 200 });
    });
};

const mount = async (props: { maxBytes?: number } = {}) => {
    await act(async () => {
        view.root.render(<EpubPreview filename="book.epub" url={URL_OF_BOOK} {...props} />);
    });
    // The fetch, the parse and the first chapter each settle in a later turn.
    await act(async () => {
        await Promise.resolve();
    });
};

const frame = (): HTMLIFrameElement => view.container.querySelector("iframe")!;
const button = (name: string): HTMLButtonElement => view.container.querySelector(`button[aria-label="${CSS.escape(name)}"]`)!;
const click = async (target: HTMLElement) => {
    await act(async () => {
        target.click();
    });
};

beforeEach(() => {
    book.opened = 0;
    book.reads = [];
    book.throwOnOpen = false;
    view.fetched = 0;
    view.container = document.createElement("div");
    document.body.append(view.container);
    view.root = createRoot(view.container);
});

afterEach(async () => {
    await act(async () => {
        view.root.unmount();
    });
    view.container.remove();
    vi.unstubAllGlobals();
});

describe("EpubPreview chapters", () => {
    it("shows the chapters one at a time in reading order, with previous and next", async () => {
        answer(new Uint8Array([1, 2, 3]));
        await mount();

        expect(view.container.textContent).toContain("Chapter 1 of 3 · Beginning");
        expect(frame().getAttribute("srcdoc")).toContain("chapter c1");
        expect(button("Previous chapter").disabled).toBe(true);

        await click(button("Next chapter"));
        expect(view.container.textContent).toContain("Chapter 2 of 3");
        expect(frame().getAttribute("srcdoc")).toContain("chapter c2");

        await click(button("Next chapter"));
        expect(view.container.textContent).toContain("Chapter 3 of 3 · End");
        expect(frame().getAttribute("srcdoc")).toContain("chapter c3");
        expect(button("Next chapter").disabled).toBe(true);

        await click(button("Previous chapter"));
        expect(frame().getAttribute("srcdoc")).toContain("chapter c2");
        expect(book.reads).toEqual(["c1", "c2", "c3", "c2"]);
    });
});

describe("EpubPreview frame", () => {
    it("shows a chapter with a script in a frame whose sandbox allows no scripts and no same origin", async () => {
        answer(new Uint8Array([1]));
        await mount();
        await click(button("Next chapter"));

        // The chapter, script included, is in the frame's document; whether it runs is the frame's `sandbox`, an empty one.
        expect(frame().getAttribute("srcdoc")).toContain("<script>window.ran = true</script>");
        expect(frame().hasAttribute("sandbox")).toBe(true);
        expect(frame().getAttribute("sandbox")).toBe("");
        expect(frame().getAttribute("sandbox")).not.toContain("allow-");
        expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
        expect((globalThis as { ran?: boolean }).ran).toBeUndefined();
    });
});

describe("EpubPreview size cap", () => {
    it("refuses a file whose declared size is over the cap, without downloading it", async () => {
        answer(new Uint8Array([1]), { "content-length": "1001" });
        await mount({ maxBytes: 1000 });

        expect(view.container.textContent).toContain("Too large to preview");
        expect(view.container.querySelector("iframe")).toBeNull();
        expect(book.opened).toBe(0);
    });

    it("refuses a file that turns out larger than the cap, whatever it declared", async () => {
        answer(new Uint8Array(1001));
        await mount({ maxBytes: 1000 });

        expect(view.container.textContent).toContain("Too large to preview");
        expect(view.container.querySelector("iframe")).toBeNull();
        expect(book.opened).toBe(0);
    });

    it("reads a file at the cap", async () => {
        answer(new Uint8Array(1000));
        await mount({ maxBytes: 1000 });

        expect(view.container.querySelector("iframe")).not.toBeNull();
        expect(view.fetched).toBe(1);
    });

    it("falls back to the download card for a file that is not a book", async () => {
        book.throwOnOpen = true;
        answer(new Uint8Array([1]));
        await mount();

        expect(view.container.textContent).toContain("Could not preview");
        expect(view.container.querySelector("iframe")).toBeNull();
    });
});
