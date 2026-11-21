// @vitest-environment jsdom

/**
 * A file is fetched into a blob before it is saved, so the browser keeps its name (a cross-origin `download` link
 * would not); a failed fetch opens the URL, as the plain link did; a modified click keeps the link's own behaviour.
 */
import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveFromUrl, saveName, saveOnClick } from "./save-from-url";

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

describe(saveFromUrl, () => {
    it("fetches the file and saves the blob under its name", async () => {
        const fetchMock = answer("%PDF", "application/pdf");

        vi.stubGlobal("fetch", fetchMock);
        await saveFromUrl("https://api.test/agent-files/abc?sig=1", "report.pdf");

        expect(fetchMock).toHaveBeenCalledWith("https://api.test/agent-files/abc?sig=1");
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
