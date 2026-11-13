// @vitest-environment jsdom

import { FetchableOriginsProvider } from "@ui/components/file-renderers/fetchable-origins-provider";
import { originsOf } from "@ui/hooks/use-fetchable-origins";
import { forgetPdfUrls, pdfFileKey } from "@ui/utils/pdf-preview-event";
import { cachePdfThumbnail, MAX_CACHED_PDF_THUMBNAILS, pdfThumbnailCacheGeneration, peekCachedPdfThumbnail } from "@ui/utils/pdf-thumbnail-cache";
import type { ReactNode } from "react";
import { act, Suspense, use } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PDF_LOAD_TIMEOUT_MS } from "./pdf-limits";
import PdfThumbnail from "./pdf-thumbnail";

const ORIGIN = "https://files.example";
const PDF_URL = `${ORIGIN}/report.pdf?sig=1`;

// Whether the stand-in first page renders, and whether the document is still loading; a test sets them before rendering.
// `workers` counts the pdf.js workers started; `documentOptions` holds the `options` each document got.
const firstPage = vi.hoisted(() => {
    return { documentOptions: [] as unknown[], documentPending: false, renders: false, workers: 0 };
});

// eslint-disable-next-line no-restricted-syntax -- the unit-test transform does not emit the worker asset
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => {
    return { default: "/pdf.worker.min.mjs" };
});

// eslint-disable-next-line no-restricted-syntax -- a stand-in for react-pdf: the document reports two pages at once
vi.mock("react-pdf", async () => {
    const { useEffect } = await import("react");

    return {
        Document: ({
            children,
            loading,
            onLoadSuccess,
            options,
        }: {
            children: ReactNode;
            loading: ReactNode;
            onLoadSuccess: (document: { numPages: number }) => void;
            options?: unknown;
        }) => {
            firstPage.documentOptions.push(options);

            useEffect(() => {
                if (!firstPage.documentPending) {
                    onLoadSuccess({ numPages: 2 });
                }
            }, [onLoadSuccess]);

            return firstPage.documentPending ? loading : children;
        },
        Page: ({ canvasRef, onRenderSuccess }: { canvasRef: { current: unknown }; onRenderSuccess: () => void }) => {
            useEffect(() => {
                if (!firstPage.renders) {
                    return;
                }

                canvasRef.current = { toDataURL: () => "data:image/png;base64,cGFnZQ==" };
                onRenderSuccess();
            }, [canvasRef, onRenderSuccess]);

            return <span data-pdf-document="" />;
        },
        pdfjs: {
            GlobalWorkerOptions: { workerSrc: "" },
            // pdf.js starts a Web Worker in this constructor; the stand-in only counts them.
            PDFWorker: class {
                public destroyed = false;

                public constructor() {
                    firstPage.workers += 1;
                }
            },
        },
    };
});

// eslint-disable-next-line no-restricted-syntax -- no macro transform in this package's vitest; nothing to inject into
vi.mock("@lingui/core/macro", () => {
    return {
        plural: (value: number, forms: { one: string; other: string }) => (value === 1 ? forms.one : forms.other).split("#").join(String(value)),
    };
});

// eslint-disable-next-line no-restricted-syntax -- see above
vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ one, other, value }: { one: string; other: string; value: number }) => (value === 1 ? one : other).split("#").join(String(value)),
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

beforeEach(() => {
    firstPage.documentOptions = [];
    firstPage.documentPending = false;
    firstPage.renders = false;
    // Drawn thumbnails are cached by file across mounts; each test starts with none.
    forgetPdfUrls();
});

describe("the thumbnail's load deadline", () => {
    let container: HTMLDivElement;
    let root: Root;

    const mountThumbnail = async () => {
        await act(async () => {
            root.render(
                <FetchableOriginsProvider origins={originsOf(ORIGIN)}>
                    <PdfThumbnail onOpen={() => {}} url={PDF_URL} />
                </FetchableOriginsProvider>,
            );
        });

        // By its accessible name, as a reader finds it: a button that lost its name fails here.
        const button = [...container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label")?.startsWith("Open PDF"));

        expect(button).toBeDefined();

        return button!;
    };

    const advance = async (ms: number) => {
        await act(async () => {
            vi.advanceTimersByTime(ms);
        });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
        vi.useRealTimers();
    });

    it("fails a first page that never renders, once the deadline passes", async () => {
        const button = await mountThumbnail();

        expect(button?.getAttribute("aria-busy")).toBe("true");

        await advance(PDF_LOAD_TIMEOUT_MS + 1);

        expect(button?.getAttribute("aria-busy")).toBe("false");
        expect(container.querySelector('[role="status"]')).not.toBeNull();
    });

    it("stops waiting once the first page has rendered, so no deadline fails it", async () => {
        firstPage.renders = true;

        const button = await mountThumbnail();

        expect(button?.getAttribute("aria-busy")).toBe("false");

        await advance(PDF_LOAD_TIMEOUT_MS + 1);

        expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("keeps the drawn first page as an image and lets the PDF document go", async () => {
        firstPage.renders = true;

        await mountThumbnail();

        expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cGFnZQ==");
        expect(container.querySelector("[data-pdf-document]")).toBeNull();
    });
});

// A render that suspends forever is never committed.
const neverResolves = new Promise<never>(() => {});
const SuspendsForever = () => use(neverResolves);

describe("the thumbnail's worker and cache", () => {
    let container: HTMLDivElement;
    let root: Root;

    const render = async (node: ReactNode) => {
        await act(async () => {
            root.render(<FetchableOriginsProvider origins={originsOf(ORIGIN)}>{node}</FetchableOriginsProvider>);
        });
    };

    /** Marks the shared worker gone (mounting a document first, so there is one), so the next document needs a new one. */
    const retireSharedWorker = async () => {
        await render(<PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/worker.pdf?sig=1`} />);

        const [options] = firstPage.documentOptions.slice(-1) as { worker: { destroyed: boolean } }[];

        options!.worker.destroyed = true;
        act(() => {
            root.unmount();
        });
        root = createRoot(container);
    };

    beforeEach(() => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it("has two thumbnails share one pdf.js worker", async () => {
        // Relative to before: other tests (in any order) may have started the shared worker already.
        const before = firstPage.workers;

        await render(
            <>
                <PdfThumbnail onOpen={() => {}} url={PDF_URL} />
                <PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/other.pdf?sig=1`} />
            </>,
        );

        const [first, second] = firstPage.documentOptions as ({ worker?: unknown } | undefined)[];

        expect(first?.worker).toBeDefined();
        expect(second?.worker).toBe(first?.worker);
        // At most the one shared worker for both documents.
        expect(firstPage.workers - before).toBeLessThanOrEqual(1);
    });

    it("shows the cached image on a remount, without loading the PDF again", async () => {
        firstPage.renders = true;

        await render(<PdfThumbnail onOpen={() => {}} url={PDF_URL} />);

        expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cGFnZQ==");

        act(() => {
            root.unmount();
        });
        root = createRoot(container);
        // The PDF would now never load: whatever shows comes from the cache.
        firstPage.renders = false;
        firstPage.documentPending = true;
        firstPage.documentOptions = [];

        // Signed again: same file, new signature.
        await render(<PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/report.pdf?sig=2`} />);

        const button = container.querySelector("button");

        expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cGFnZQ==");
        expect(button?.getAttribute("aria-busy")).toBe("false");
        expect(button?.getAttribute("aria-label")).toBe("Open PDF, 2 pages");
        expect(firstPage.documentOptions).toHaveLength(0);
    });

    it("forgets cached thumbnails when the session ends", async () => {
        firstPage.renders = true;

        await render(<PdfThumbnail onOpen={() => {}} url={PDF_URL} />);

        act(() => {
            root.unmount();
        });
        root = createRoot(container);
        forgetPdfUrls();
        firstPage.renders = false;
        firstPage.documentPending = true;

        await render(<PdfThumbnail onOpen={() => {}} url={PDF_URL} />);

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
    });

    it("does not cache a page whose draw started before the session ended", async () => {
        // The draw starts, then the session ends before the page is drawn.
        firstPage.renders = false;
        await render(<PdfThumbnail onOpen={() => {}} url={PDF_URL} />);

        forgetPdfUrls();
        // The page finishes drawing for the old session (the stand-in page draws on the next render).
        firstPage.renders = true;
        await render(<PdfThumbnail onOpen={() => {}} url={PDF_URL} />);

        expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cGFnZQ==");

        // The next account's thumbnail of the same file: nothing cached, so it loads (and never finishes here).
        act(() => {
            root.unmount();
        });
        root = createRoot(container);
        firstPage.renders = false;
        firstPage.documentPending = true;

        await render(<PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/report.pdf?sig=next-account`} />);

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
    });

    it("starts the shared worker after commit, not in a render that is thrown away", async () => {
        await retireSharedWorker();

        const before = firstPage.workers;

        await render(
            <Suspense fallback={<p>waiting</p>}>
                <PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/thrown-away.pdf?sig=1`} />
                <SuspendsForever />
            </Suspense>,
        );

        expect(container.textContent).toBe("waiting");
        expect(firstPage.workers).toBe(before);

        act(() => {
            root.unmount();
        });
        root = createRoot(container);
        await render(<PdfThumbnail onOpen={() => {}} url={`${ORIGIN}/mounted.pdf?sig=1`} />);

        expect(firstPage.workers).toBe(before + 1);
    });

    it("starts no worker for a refused URL, and one once the URL may be fetched", async () => {
        await retireSharedWorker();

        const elsewhere = "https://elsewhere.example/report.pdf?sig=1";
        const before = firstPage.workers;
        const mount = async (origins: ReadonlyArray<string>) => {
            await act(async () => {
                root.render(
                    <FetchableOriginsProvider origins={origins}>
                        <PdfThumbnail onOpen={() => {}} url={elsewhere} />
                    </FetchableOriginsProvider>,
                );
            });
        };

        await mount(originsOf(ORIGIN));

        expect(container.querySelector('[role="status"]')).not.toBeNull();
        expect(firstPage.workers).toBe(before);

        // The same thumbnail, now allowed to fetch that origin.
        await mount(originsOf(ORIGIN, elsewhere));

        expect(firstPage.workers).toBe(before + 1);
    });

    it("does not cache an inline PDF, whose key would hold the whole file", async () => {
        const inline = `data:application/pdf;base64,${"JVBERi0xLjQK".repeat(500)}`;

        firstPage.renders = true;
        await render(<PdfThumbnail onOpen={() => {}} url={inline} />);

        expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cGFnZQ==");
        expect(peekCachedPdfThumbnail(pdfFileKey(inline))).toBeUndefined();

        // Mounted again, it loads again instead of showing a cached image.
        act(() => {
            root.unmount();
        });
        root = createRoot(container);
        firstPage.renders = false;
        firstPage.documentPending = true;
        await render(<PdfThumbnail onOpen={() => {}} url={inline} />);

        expect(container.querySelector("img")).toBeNull();
    });
});

describe("the thumbnail cache's eviction order", () => {
    let container: HTMLDivElement;
    let root: Root;

    const A_URL = `${ORIGIN}/a.pdf?sig=1`;
    const A_KEY = `${ORIGIN}/a.pdf`;
    const otherKey = (index: number) => `${ORIGIN}/other-${String(index)}.pdf`;
    const thumbnail = { pages: 1, snapshot: "data:image/png;base64,YQ==" };

    /** Caches A first (the least recently used), then fills the cache with other files. */
    const fillWithAOldest = () => {
        cachePdfThumbnail(A_KEY, thumbnail, pdfThumbnailCacheGeneration());

        for (let index = 1; index < MAX_CACHED_PDF_THUMBNAILS; index += 1) {
            cachePdfThumbnail(otherKey(index), thumbnail, pdfThumbnailCacheGeneration());
        }
    };

    /** One more file: the least recently used entry is evicted. */
    const addOneMore = () => {
        cachePdfThumbnail(otherKey(MAX_CACHED_PDF_THUMBNAILS), thumbnail, pdfThumbnailCacheGeneration());
    };

    // Suspends forever: the render it is part of is never committed.
    const never = new Promise<never>(() => {});
    const Suspends = () => use(never);

    beforeEach(() => {
        firstPage.documentPending = true;
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it("is not changed by a render that is thrown away", async () => {
        fillWithAOldest();

        await act(async () => {
            root.render(
                <FetchableOriginsProvider origins={originsOf(ORIGIN)}>
                    <Suspense fallback={<p>waiting</p>}>
                        <PdfThumbnail onOpen={() => {}} url={A_URL} />
                        <Suspends />
                    </Suspense>
                </FetchableOriginsProvider>,
            );
        });

        // The thumbnail rendered (it looked A up) but never mounted.
        expect(container.textContent).toBe("waiting");

        addOneMore();

        // A is still the least recently used, so it is the one evicted.
        expect(peekCachedPdfThumbnail(A_KEY)).toBeUndefined();
        expect(peekCachedPdfThumbnail(otherKey(1))).toBeDefined();
    });

    it("marks the entry used when the thumbnail mounts", async () => {
        fillWithAOldest();

        await act(async () => {
            root.render(
                <FetchableOriginsProvider origins={originsOf(ORIGIN)}>
                    <PdfThumbnail onOpen={() => {}} url={A_URL} />
                </FetchableOriginsProvider>,
            );
        });

        expect(container.querySelector("img")?.getAttribute("src")).toBe(thumbnail.snapshot);

        addOneMore();

        // A was used after the others: the oldest other file goes instead.
        expect(peekCachedPdfThumbnail(A_KEY)).toBe(thumbnail);
        expect(peekCachedPdfThumbnail(otherKey(1))).toBeUndefined();
    });
});
