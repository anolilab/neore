// @vitest-environment jsdom

import { FetchableOriginsProvider } from "@ui/components/file-renderers/fetchable-origins-provider";
import { originsOf } from "@ui/hooks/use-fetchable-origins";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PDF_LOAD_TIMEOUT_MS } from "./pdf-limits";
import PdfThumbnail from "./pdf-thumbnail";

const ORIGIN = "https://files.example";
const PDF_URL = `${ORIGIN}/report.pdf?sig=1`;

// Whether the stand-in first page renders, and whether the document is still loading; a test sets them before rendering.
const firstPage = vi.hoisted(() => {
    return { documentPending: false, renders: false };
});

// eslint-disable-next-line no-restricted-syntax -- the unit-test transform does not load pdf.js; the worker module is a no-op here
vi.mock("./pdf-worker", () => {
    return {};
});

// eslint-disable-next-line no-restricted-syntax -- a stand-in for react-pdf: the document reports two pages at once
vi.mock("react-pdf", async () => {
    const { useEffect } = await import("react");

    return {
        Document: ({
            children,
            loading,
            onLoadSuccess,
        }: {
            children: ReactNode;
            loading: ReactNode;
            onLoadSuccess: (document: { numPages: number }) => void;
        }) => {
            useEffect(() => {
                if (!firstPage.documentPending) {
                    onLoadSuccess({ numPages: 2 });
                }
            }, [onLoadSuccess]);

            return firstPage.documentPending ? loading : children;
        },
        Page: ({ onRenderSuccess }: { onRenderSuccess: () => void }) => {
            useEffect(() => {
                if (firstPage.renders) {
                    onRenderSuccess();
                }
            }, [onRenderSuccess]);

            return null;
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

        return container.querySelector("button");
    };

    const advance = async (ms: number) => {
        await act(async () => {
            vi.advanceTimersByTime(ms);
        });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        firstPage.documentPending = false;
        firstPage.renders = false;
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

    // The loading placeholder pulses through a class, and the reduced-motion preference is a CSS media query, so jsdom cannot
    // evaluate it. This pins the class that switches the pulse off under `prefers-reduced-motion: reduce`.
    it("switches the loading placeholder's pulse off under reduced motion", async () => {
        firstPage.documentPending = true;

        await mountThumbnail();

        const placeholder = container.querySelector("span.animate-pulse");

        expect(placeholder?.classList.contains("motion-reduce:animate-none")).toBe(true);
    });
});
