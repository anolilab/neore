// @vitest-environment jsdom

/**
 * A download belongs to the document it started for. Switching to another document while it is still fetching must not save
 * the one the reader left, and a download after the switch fetches the document on screen.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";

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
    return { default: () => null };
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

    it("downloads from the file's newest signed URL, not the one the panel opened with", () => {
        const resigned = "https://api.example/files/a.pdf?sig=renewed";

        render(panelFor(DOCUMENT_A));
        rememberPdfUrl(resigned);
        clickDownload();

        expect(fetchSpy).toHaveBeenCalledWith(resigned, expect.anything());
    });
});
