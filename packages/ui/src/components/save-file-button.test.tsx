// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import SaveFileButton from "./save-file-button";

const { saveFromUrl } = vi.hoisted(() => {
    return { saveFromUrl: vi.fn((_url: string, _filename?: string, _fallbackName?: string) => Promise.resolve()) };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; the download call is the thing under test
vi.mock("@ui/utils/save-from-url", () => {
    return { saveFromUrl };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) =>
                    strings.reduce((out, part, index) => `${out}${part}${index < values.length ? String(values[index]) : ""}`, ""),
            };
        },
    };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const host = document.createElement("div");

document.body.append(host);

const root = createRoot(host);

const render = (element: React.ReactElement): HTMLButtonElement => {
    act(() => root.render(element));

    return host.querySelector("button") as HTMLButtonElement;
};

afterEach(() => {
    act(() => root.render(<></>));
    saveFromUrl.mockClear();
});

describe("SaveFileButton", () => {
    it("is named by its file", () => {
        const button = render(<SaveFileButton filename="report.pdf" url="https://files.test/report.pdf" />);

        expect(button.getAttribute("aria-label")).toBe("Download report.pdf");
        expect(button.getAttribute("type")).toBe("button");
    });

    it("is named Download when the file has no name", () => {
        const button = render(<SaveFileButton fallbackName="audio" url="https://files.test/clip" />);

        expect(button.getAttribute("aria-label")).toBe("Download");
    });

    it("is named by its label when one is given, and still saves under the file's name", () => {
        const button = render(<SaveFileButton filename="cat.png" label="Download Generated image (2)" url="https://files.test/cat.png" />);

        expect(button.getAttribute("aria-label")).toBe("Download Generated image (2)");

        act(() => button.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/cat.png", "cat.png", undefined);
    });

    it("saves the file at its URL under its name", () => {
        const button = render(<SaveFileButton filename="report.pdf" url="https://files.test/report.pdf" />);

        act(() => button.click());

        expect(saveFromUrl).toHaveBeenCalledTimes(1);
        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/report.pdf", "report.pdf", undefined);
    });

    it("passes the fallback name when there is no file name", () => {
        const button = render(<SaveFileButton fallbackName="video" url="https://files.test/clip" />);

        act(() => button.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/clip", undefined, "video");
    });

    it("takes keyboard focus", () => {
        const button = render(<SaveFileButton filename="report.pdf" url="https://files.test/report.pdf" />);

        expect(button.tabIndex).toBeGreaterThanOrEqual(0);

        act(() => button.focus());

        expect(document.activeElement).toBe(button);
    });
});
