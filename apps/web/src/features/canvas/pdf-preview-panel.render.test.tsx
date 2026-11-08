// @vitest-environment jsdom

/**
 * A download belongs to the document it started for. Switching to another document while it is still fetching must not save
 * the one the reader left, and a download after the switch fetches the document on screen.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";
import { showError } from "@/lib/toast";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

// The viewer is lazy and needs pdf.js; the download does not read it.
vi.mock("@neore/ui/components/file-renderers/pdf-viewer", () => {
    return {
        default: ({ url }: { url: string }) => {
            if (url.includes("broken")) {
                throw new Error("viewer failed");
            }

            return null;
        },
    };
});

// The panel reads its backend origin at load, so the origin is set before the module is imported.
vi.stubEnv("VITE_LUNORA_URL", "https://api.example");

const { default: PdfPreviewPanel } = await import("./pdf-preview-panel");
const { rememberPdfUrl } = await import("@neore/ui/utils/pdf-preview-event");

const DOCUMENT_A = { filename: "a.pdf", threadId: "thread-1", url: "https://api.example/files/a.pdf?sig=a" };
const DOCUMENT_B = { filename: "b.pdf", threadId: "thread-1", url: "https://api.example/files/b.pdf?sig=b" };

interface PendingFetch {
    resolve: (response: Response) => void;
    url: string;
}

// The fetches the panel starts, each answered by the test. The fetch ignores the abort signal, so an answer can arrive after a
// switch, as a slow network would deliver it.
const pendingFetches: PendingFetch[] = [];
const fetchSpy = vi.fn(
    (url: string) =>
        new Promise<Response>((resolve) => {
            pendingFetches.push({ resolve, url });
        }),
);

// The save is a click on a temporary link: record the link instead of letting jsdom navigate to a blob URL.
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

const originalCreateObjectUrl = URL.createObjectURL;
const createObjectUrl = vi.fn(() => "blob:saved");

Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl, writable: true });

const panelFor = (file: PreviewFile) => <PdfPreviewPanel file={file} />;

const flush = async () => {
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    });
};

const clickDownload = () => {
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
};

// The file name of each link the panel clicked to save.
const savedFilenames = () => clickSpy.mock.contexts.map((element) => (element instanceof HTMLAnchorElement ? element.download : ""));

describe("the side panel's download after a document switch", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        pendingFetches.length = 0;
        fetchSpy.mockClear();
        createObjectUrl.mockClear();
        clickSpy.mockClear();
        vi.unstubAllGlobals();
    });

    afterAll(() => {
        clickSpy.mockRestore();
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl, writable: true });
    });

    it("saves nothing from a download that was still fetching when the document changed", async () => {
        const { rerender } = render(panelFor(DOCUMENT_A));

        clickDownload();

        expect(fetchSpy).toHaveBeenCalledWith(DOCUMENT_A.url, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        // The switch: the same panel now shows another document.
        rerender(panelFor(DOCUMENT_B));

        await act(async () => {
            pendingFetches[0]?.resolve(new Response(new Blob(["A"]), { status: 200 }));
        });
        await flush();

        expect(createObjectUrl).not.toHaveBeenCalled();
        expect(savedFilenames()).toEqual([]);
    });
});

describe("the side panel's opener and links", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        pendingFetches.length = 0;
        fetchSpy.mockClear();
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    it("returns focus to the thumbnail that opened the file on screen when the panel closes", () => {
        const thumbnailA = document.createElement("button");
        const thumbnailB = document.createElement("button");

        document.body.appendChild(thumbnailA);
        document.body.appendChild(thumbnailB);

        const { rerender, unmount } = render(panelFor({ ...DOCUMENT_A, opener: thumbnailA }));

        rerender(panelFor({ ...DOCUMENT_B, opener: thumbnailB }));

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this test asserts
        expect(document.activeElement).toBe(screen.getByRole("heading", { name: "b.pdf" }));

        unmount();

        // eslint-disable-next-line testing-library/no-node-access -- see above
        expect(document.activeElement).toBe(thumbnailB);
    });

    it("returns focus to the same file's new thumbnail when the one that opened it remounted after a re-sign", () => {
        const opener = document.createElement("button");
        const remounted = document.createElement("button");

        remounted.dataset.pdfFile = "https://api.example/files/a.pdf";
        document.body.appendChild(opener);

        const { unmount } = render(panelFor({ ...DOCUMENT_A, opener }));

        opener.remove();
        document.body.appendChild(remounted);
        unmount();

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this test asserts
        expect(document.activeElement).toBe(remounted);
    });

    it("links the new tab to the file's newest signed URL, so a middle click or a copied link is not the expired one", () => {
        const resigned = "https://api.example/files/a.pdf?sig=renewed-link";

        rememberPdfUrl(resigned);
        render(panelFor(DOCUMENT_A));

        expect(screen.getByRole("link", { name: "Open PDF in a new tab to print" }).getAttribute("href")).toBe(resigned);
    });

    it("downloads from the file's newest signed URL, not the one the panel opened with", () => {
        const resigned = "https://api.example/files/a.pdf?sig=renewed";

        render(panelFor(DOCUMENT_A));
        rememberPdfUrl(resigned);
        clickDownload();

        expect(fetchSpy).toHaveBeenCalledWith(resigned, expect.anything());
    });
});

describe("the side panel's failures", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        pendingFetches.length = 0;
        fetchSpy.mockClear();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.mocked(showError).mockClear();
        createObjectUrl.mockClear();
    });

    it("reports a download that stops arriving, rather than leaving it pending", async () => {
        vi.useFakeTimers();
        // A request that never answers, and fails only when it is aborted, as a real fetch does.
        vi.stubGlobal(
            "fetch",
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                }),
        );
        render(panelFor(DOCUMENT_A));
        clickDownload();

        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });

        expect(screen.getByRole("alert").textContent).toBe("The PDF could not be downloaded.");
    });

    it("refuses a download past the chat PDF cap rather than holding it in memory", async () => {
        // Chunks past the cap, as a body read from the network arrives.
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        const oversized = new ReadableStream<Uint8Array>({
            pull: (controller) => {
                sent += 1;

                if (sent > 30) {
                    controller.close();
                } else {
                    controller.enqueue(chunk);
                }
            },
        });

        vi.stubGlobal("fetch", async () => new Response(oversized, { status: 200 }));
        render(panelFor(DOCUMENT_A));
        clickDownload();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("The PDF could not be downloaded.");
        expect(createObjectUrl).not.toHaveBeenCalled();
    });

    it("lets the previous saved file go when the next download is saved, also from a reopened panel", async () => {
        const revoke = vi.fn();

        // The first block restores the real object URL functions after it; this test stands them in again.
        Object.defineProperties(URL, {
            createObjectURL: { configurable: true, value: createObjectUrl, writable: true },
            revokeObjectURL: { configurable: true, value: revoke, writable: true },
        });
        vi.stubGlobal("fetch", async () => new Response("pdf", { status: 200 }));
        const { unmount } = render(panelFor(DOCUMENT_A));

        clickDownload();
        await waitFor(() => {
            expect(createObjectUrl).toHaveBeenCalledTimes(1);
        });
        // The panel is closed and opened again before the next download.
        unmount();
        render(panelFor(DOCUMENT_A));
        clickDownload();
        await waitFor(() => {
            expect(createObjectUrl).toHaveBeenCalledTimes(2);
        });

        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it("keeps a viewer failure to its own file, without a toast, so the next PDF opens", async () => {
        // The viewer's thrown error is logged by React; silenced for this test only, and restored even if it fails.
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const { rerender } = render(panelFor({ ...DOCUMENT_A, url: "https://api.example/files/broken.pdf?sig=x" }));

            expect(await screen.findByText("This preview could not be loaded.")).toBeDefined();

            rerender(panelFor(DOCUMENT_B));

            await waitFor(() => {
                expect(screen.queryByText("This preview could not be loaded.")).toBeNull();
            });
            expect(showError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });
});
