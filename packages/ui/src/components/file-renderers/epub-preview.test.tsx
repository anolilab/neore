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
    return {
        chapters: 3,
        destroyed: 0,
        guard: undefined as Error | undefined,
        guardArgs: [] as unknown[],
        opened: 0,
        openGate: undefined as Promise<void> | undefined,
        readGate: undefined as Promise<void> | undefined,
        reads: [] as string[],
        stall: false,
        throwOnOpen: false,
    };
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

            if (book.openGate !== undefined) {
                await book.openGate;
            }

            let destroyed = false;
            const number = book.opened;

            return {
                chapters: [{ id: "c1", title: "Beginning" }, { id: "c2" }, { id: "c3", title: "End" }].slice(0, book.chapters),
                destroy: () => {
                    if (destroyed) {
                        return;
                    }

                    destroyed = true;
                    book.destroyed += 1;
                },
                get destroyed() {
                    return destroyed;
                },
                read: async (id: string) => {
                    book.reads.push(id);

                    if (book.stall) {
                        await new Promise(() => {});
                    }

                    if (book.readGate !== undefined) {
                        await book.readGate;
                    }

                    return `<body>book ${String(number)} chapter ${id}${id === "c2" ? "<script>window.ran = true</script>" : ""}</body>`;
                },
            };
        },
    };
});

// The zip guard looks inside a real archive; the stand-in bytes below are not one.
// eslint-disable-next-line no-restricted-syntax -- see above
vi.mock("@ui/utils/office-zip-limits", () => {
    return {
        assertOfficeZipWithinLimits: async (_buffer: ArrayBuffer, limits: unknown) => {
            book.guardArgs.push(limits);

            if (book.guard !== undefined) {
                throw book.guard;
            }
        },
        OFFICE_ZIP_MAX_ENTRIES: 2000,
        OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES: 50 * 1024 * 1024,
    };
});

const { default: EpubPreview } = await import("./epub-preview");
const { FetchableOriginsProvider } = await import("./fetchable-origins-provider");

const ORIGIN = "https://files.example";
const URL_OF_BOOK = `${ORIGIN}/book.epub?sig=1`;

const view = { container: undefined as unknown as HTMLDivElement, fetched: 0, root: undefined as unknown as Root };

const answer = (body: BodyInit, headers: Record<string, string> = {}) => {
    vi.stubGlobal("fetch", async () => {
        view.fetched += 1;

        return new Response(body, { headers, status: 200 });
    });
};

const mount = async (props: { maxBytes?: number; url?: string } = {}) => {
    await act(async () => {
        view.root.render(
            <FetchableOriginsProvider origins={[ORIGIN]}>
                <EpubPreview filename="book.epub" url={URL_OF_BOOK} {...props} />
            </FetchableOriginsProvider>,
        );
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
    book.chapters = 3;
    book.destroyed = 0;
    book.guard = undefined;
    book.guardArgs = [];
    book.openGate = undefined;
    book.readGate = undefined;
    book.opened = 0;
    book.reads = [];
    book.stall = false;
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

describe("EpubPreview address", () => {
    it.each([
        ["another origin", "https://evil.example/book.epub"],
        ["a loopback service", "http://127.0.0.1:8080/book.epub"],
        ["a scheme the app does not serve", "ftp://files.example/book.epub"],
        ["a file address", "file:///etc/passwd"],
    ])("refuses %s without a request", async (_name, url) => {
        answer(new Uint8Array([1]));
        await mount({ url });

        expect(view.container.textContent).toContain("Could not preview");
        expect(view.container.querySelector("iframe")).toBeNull();
        expect(view.fetched).toBe(0);
        expect(book.opened).toBe(0);
    });

    it("reads the app's own file address", async () => {
        answer(new Uint8Array([1]));
        await mount();

        expect(view.fetched).toBe(1);
        expect(view.container.querySelector("iframe")).not.toBeNull();
    });
});

describe("EpubPreview size", () => {
    it("holds the archive to the same cap as the download, not the guard's default", async () => {
        answer(new Uint8Array(10));
        await mount({ maxBytes: 1000 });

        expect(book.guardArgs).toEqual([{ maxBytes: 1000, maxEntries: 2000 }]);
    });

    it.each(["Archive expands too large", "Archive has too many entries"])("shows %s as too large to preview, not as a failure", async (message) => {
        book.guard = new Error(message);
        answer(new Uint8Array(10));
        await mount();

        expect(view.container.textContent).toContain("Too large to preview");
        expect(book.opened).toBe(0);
    });

    it("shows an archive that is not a book as a failure", async () => {
        book.guard = new Error("Not a ZIP archive");
        answer(new Uint8Array(10));
        await mount();

        expect(view.container.textContent).toContain("Could not preview");
    });

    it("stops reading a body that passes the cap without ever declaring a length", async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(400));

                if (pulled > 50) {
                    controller.close();
                }
            },
        });

        vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
        await mount({ maxBytes: 1000 });

        expect(view.container.textContent).toContain("Too large to preview");
        // Cancelled soon after the cap, not read to its end.
        expect(pulled).toBeLessThan(10);
    });
});

describe("EpubPreview failures", () => {
    it("releases a book with nothing to read", async () => {
        book.chapters = 0;
        answer(new Uint8Array([1]));
        await mount();

        expect(view.container.textContent).toContain("Could not preview");
        expect(book.destroyed).toBe(1);
    });

    it("ends a chapter whose read stalls in the failure card, and releases the book", async () => {
        vi.useFakeTimers();

        try {
            book.stall = true;
            answer(new Uint8Array([1]));
            await mount();
            await act(async () => {
                vi.advanceTimersByTime(30_001);
            });
            await act(async () => {
                await Promise.resolve();
            });

            expect(view.container.textContent).toContain("Could not preview");
            expect(book.destroyed).toBeGreaterThanOrEqual(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("EpubPreview load generations", () => {
    const render = async (props: { maxBytes?: number; url: string }) => {
        await act(async () => {
            view.root.render(
                <FetchableOriginsProvider origins={[ORIGIN]}>
                    <EpubPreview filename="book.epub" {...props} />
                </FetchableOriginsProvider>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
    };
    const gate = () => {
        let release: () => void = () => undefined;
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the configured Node range (22.0) predates `Promise.withResolvers`
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });

        return { promise, release };
    };
    const settle = async () => {
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await Promise.resolve();
        });
    };

    it("does not show a book again after its load was torn down: an A to B to A sequence waits for a fresh load", async () => {
        answer(new Uint8Array([1]));
        await render({ url: `${ORIGIN}/a.epub` });
        expect(view.container.textContent).toContain("Chapter 1 of 3");

        // To B, whose load never finishes while the person goes back to A.
        const stalled = gate();

        book.openGate = stalled.promise;
        await render({ url: `${ORIGIN}/b.epub` });
        expect(book.destroyed).toBe(1);
        await render({ url: `${ORIGIN}/a.epub` });

        // A's old book was destroyed by its effect's cleanup: its chapters and controls are not shown while the new load is on its way.
        expect(view.container.querySelector("iframe")).toBeNull();
        expect(view.container.textContent).not.toContain("Chapter 1 of 3");

        stalled.release();
        await settle();
        expect(view.container.textContent).toContain("Chapter 1 of 3");
        expect(view.container.querySelector("iframe")).not.toBeNull();
    });

    it("loads again, and shows nothing of the old book meanwhile, when the cap changes for the same file", async () => {
        answer(new Uint8Array([1]));
        await render({ maxBytes: 1000, url: `${ORIGIN}/a.epub` });
        expect(view.container.querySelector("iframe")).not.toBeNull();

        const stalled = gate();

        book.openGate = stalled.promise;
        await render({ maxBytes: 2000, url: `${ORIGIN}/a.epub` });
        expect(book.destroyed).toBe(1);
        expect(view.container.querySelector("iframe")).toBeNull();

        stalled.release();
        await settle();
        expect(view.container.querySelector("iframe")).not.toBeNull();
    });

    it("ends a load stuck in parsing at the deadline, and releases a book that arrives after it", async () => {
        vi.useFakeTimers();

        try {
            const stalled = gate();

            book.openGate = stalled.promise;
            answer(new Uint8Array([1]));
            await mount();
            expect(view.container.querySelector("iframe")).toBeNull();

            await act(async () => {
                vi.advanceTimersByTime(30_001);
            });
            await settle();
            expect(view.container.textContent).toContain("Could not preview");

            stalled.release();
            await settle();
            expect(book.destroyed).toBe(1);
            expect(view.container.querySelector("iframe")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("EpubPreview other books and bodies", () => {
    const render = async (url: string) => {
        await act(async () => {
            view.root.render(
                <FetchableOriginsProvider origins={[ORIGIN]}>
                    <EpubPreview filename="book.epub" url={url} />
                </FetchableOriginsProvider>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
    };

    it("does not show the chapter of an earlier book once another book is the one shown", async () => {
        answer(new Uint8Array([1]));
        await render(`${ORIGIN}/a.epub`);
        expect(frame().getAttribute("srcdoc")).toContain("book 1 chapter c1");

        // The next book is ready, but its first chapter is still being read: the earlier book's chapter is not shown in its place.
        let release: () => void = () => undefined;

        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the configured Node range (22.0) predates `Promise.withResolvers`
        book.readGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await render(`${ORIGIN}/b.epub`);
        expect(view.container.querySelector("iframe")).not.toBeNull();
        expect(frame().getAttribute("srcdoc") ?? "").not.toContain("book 1");
        expect(frame().hasAttribute("srcdoc")).toBe(false);

        release();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(frame().getAttribute("srcdoc")).toContain("book 2 chapter c1");
    });

    it("lets go of the body of a response that declares more than the cap, without reading it", async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                controller.enqueue(new Uint8Array(10));
            },
        });

        vi.stubGlobal("fetch", async () => new Response(stream, { headers: { "content-length": "5000" }, status: 200 }));
        await act(async () => {
            view.root.render(
                <FetchableOriginsProvider origins={[ORIGIN]}>
                    <EpubPreview filename="book.epub" maxBytes={1000} url={`${ORIGIN}/big.epub`} />
                </FetchableOriginsProvider>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(view.container.textContent).toContain("Too large to preview");
        expect(cancelled).toBe(true);
        expect(book.opened).toBe(0);
    });
});
