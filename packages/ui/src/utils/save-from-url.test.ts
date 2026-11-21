// @vitest-environment jsdom

/**
 * A file is fetched into a blob before it is saved, so the browser keeps its name (a cross-origin `download` link
 * would not); a failed fetch opens the URL, as the plain link did; a modified click keeps the link's own behaviour.
 */
import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEADERS_DEADLINE_MS, safeImageDownloadUrl, saveFromUrl, saveName, saveOnClick } from "./save-from-url";

// One spy for the whole file, cleared before each test: every click's `this` is the anchor the helper made.
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

/** The links the helper clicked. */
const clickedLinks = () =>
    (clickSpy.mock.contexts as HTMLAnchorElement[]).map((anchor) => {
        return { download: anchor.download, href: anchor.href, target: anchor.target };
    });

beforeEach(() => {
    clickSpy.mockClear();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:https://app.test/1", revokeObjectURL: () => {} }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const answer = (body: string, type: string, ok = true) =>
    vi.fn(async () => {
        return { blob: async () => new Blob([body], { type }), body: null, ok, status: ok ? 200 : 403 };
    });

describe(saveName, () => {
    it.each([
        ["report.pdf", "application/pdf", "report.pdf"],
        ["chart", "image/png", "chart.png"],
        ["Report", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Report.docx"],
        ["Budget", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Budget.xlsx"],
        ["manifest.webmanifest", "application/json", "manifest.webmanifest"],
        [undefined, "image/jpeg; charset=binary", "download.jpg"],
        ["  ", undefined, "download"],
        ["notes", "application/x-unknown", "notes"],
    ])("%s of type %s is saved as %s", (filename, type, expected) => {
        expect(saveName(filename, type)).toBe(expected);
    });

    it("uses the fallback name when there is no file name", () => {
        expect(saveName(undefined, "image/webp", "image")).toBe("image.webp");
    });
});

describe(safeImageDownloadUrl, () => {
    it.each(["https://api.test/agent-files/a?sig=1", "blob:https://app.test/1", "data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/"])(
        "links %s",
        (url) => {
            expect(safeImageDownloadUrl(url)).toBe(url);
        },
    );

    it.each([
        ["javascript", ":alert(document.domain)"].join(""),
        "data:text/html,<b>x</b>",
        "data:image/svg+xml,<svg onload=alert(1)>",
        "file:///etc/passwd",
        "DATA:text/html,<b>x</b>",
        " data:text/html,<b>x</b>",
        "Data:image/svg+xml,<svg>",
    ])("links nothing for %s", (url) => {
        expect(safeImageDownloadUrl(url)).toBeUndefined();
    });
});

describe(saveFromUrl, () => {
    it("fetches the file and saves the blob under its name", async () => {
        const fetchMock = answer("%PDF", "application/pdf");

        vi.stubGlobal("fetch", fetchMock);
        await saveFromUrl("https://api.test/agent-files/abc?sig=1", "report.pdf");

        expect(fetchMock).toHaveBeenCalledWith("https://api.test/agent-files/abc?sig=1", expect.objectContaining({ referrerPolicy: "no-referrer" }));
        expect(clickedLinks()).toEqual([{ download: "report.pdf", href: "blob:https://app.test/1", target: "" }]);
    });

    it("names a nameless file from its type", async () => {
        vi.stubGlobal("fetch", answer("png", "image/png"));
        await saveFromUrl("https://api.test/agent-files/abc?sig=1", undefined, "image");

        expect(clickedLinks()[0]?.download).toBe("image.png");
    });

    it("opens the URL in a new tab when the file cannot be fetched", async () => {
        vi.stubGlobal("fetch", answer("", "text/plain", false));
        await saveFromUrl("https://api.test/agent-files/abc?sig=1", "notes.txt");

        expect(clickedLinks()).toEqual([{ download: "notes.txt", href: "https://api.test/agent-files/abc?sig=1", target: "_blank" }]);
    });

    it("opens the URL in a new tab when the fetch throws", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );
        await saveFromUrl("https://api.test/x", "x.csv");

        expect(clickedLinks()[0]?.target).toBe("_blank");
    });

    // eslint-disable-next-line no-script-url -- the scheme under test
    it.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://files.test/a.txt"])("neither fetches nor opens %s", async (url) => {
        const fetchMock = vi.fn();

        vi.stubGlobal("fetch", fetchMock);
        await saveFromUrl(url, "a.txt");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(clickedLinks()).toEqual([]);
    });

    it("fetches a second click on the same file only once", async () => {
        const fetchMock = answer("a", "text/plain");

        vi.stubGlobal("fetch", fetchMock);
        await Promise.all([saveFromUrl("https://api.test/a", "a.txt"), saveFromUrl("https://api.test/a", "a.txt")]);
        await saveFromUrl("https://api.test/a", "a.txt");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(clickedLinks()).toHaveLength(2);
    });

    describe("deadline", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("opens the URL while the click still counts when the headers are late", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async (_url: string, init: RequestInit) =>
                        await new Promise((_resolve, reject) => {
                            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                        }),
                ),
            );

            const saving = saveFromUrl("https://api.test/slow", "slow.pdf");

            await vi.advanceTimersByTimeAsync(HEADERS_DEADLINE_MS);
            await saving;

            expect(clickedLinks()).toEqual([{ download: "slow.pdf", href: "https://api.test/slow", target: "_blank" }]);
        });

        it("lets a long body finish once the headers are in", async () => {
            let signal: AbortSignal | undefined;

            vi.stubGlobal(
                "fetch",
                vi.fn(async (_url: string, init: RequestInit) => {
                    signal = init.signal ?? undefined;

                    return {
                        blob: async () => {
                            await new Promise((resolve) => {
                                setTimeout(resolve, HEADERS_DEADLINE_MS * 10);
                            });

                            return new Blob(["big"], { type: "video/mp4" });
                        },
                        body: null,
                        ok: true,
                        status: 200,
                    };
                }),
            );

            const saving = saveFromUrl("https://api.test/big", "big.mp4");

            await vi.advanceTimersByTimeAsync(HEADERS_DEADLINE_MS * 10);
            await saving;

            expect(signal?.aborted).toBe(false);
            expect(clickedLinks()).toEqual([{ download: "big.mp4", href: "blob:https://app.test/1", target: "" }]);
        });

        it("waits for slow headers when the caller asks for no deadline, and saves the blob", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async (_url: string, init: RequestInit) => {
                    await new Promise((resolve) => {
                        setTimeout(resolve, HEADERS_DEADLINE_MS * 5);
                    });

                    if (init.signal?.aborted) {
                        throw new DOMException("aborted", "AbortError");
                    }

                    return { blob: async () => new Blob(["%PDF"], { type: "application/pdf" }), body: null, ok: true, status: 200 };
                }),
            );

            const saving = saveFromUrl("https://api.test/vault", "contract.pdf", undefined, { headersDeadlineMs: null });

            await vi.advanceTimersByTimeAsync(HEADERS_DEADLINE_MS * 5);
            await saving;

            expect(clickedLinks()).toEqual([{ download: "contract.pdf", href: "blob:https://app.test/1", target: "" }]);
        });
    });
});

describe(saveOnClick, () => {
    const click = (overrides: Partial<Record<"altKey" | "button" | "ctrlKey" | "defaultPrevented" | "metaKey" | "shiftKey", unknown>> = {}) => {
        const event = {
            altKey: false,
            button: 0,
            ctrlKey: false,
            defaultPrevented: false,
            metaKey: false,
            preventDefault: vi.fn(),
            shiftKey: false,
            ...overrides,
        };

        return event as unknown as MouseEvent<HTMLAnchorElement> & { preventDefault: ReturnType<typeof vi.fn> };
    };

    it("takes over a plain click and saves the file", async () => {
        const fetchMock = answer("a", "text/plain");

        vi.stubGlobal("fetch", fetchMock);

        const event = click();

        saveOnClick("https://api.test/a", "a.txt")(event);
        await vi.waitFor(() => {
            expect(clickedLinks()).toHaveLength(1);
        });

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a middle click", { button: 1 }],
        ["a click with Ctrl", { ctrlKey: true }],
        ["a click with Cmd", { metaKey: true }],
        ["a click with Shift", { shiftKey: true }],
        ["a click already handled", { defaultPrevented: true }],
    ])("leaves %s to the link", (_label, overrides) => {
        const fetchMock = vi.fn();

        vi.stubGlobal("fetch", fetchMock);

        const event = click(overrides);

        saveOnClick("https://api.test/a", "a.txt")(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves a link with no URL alone", () => {
        const event = click();

        saveOnClick(undefined, "a.txt")(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});
