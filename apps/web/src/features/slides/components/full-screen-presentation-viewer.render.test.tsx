// @vitest-environment jsdom
/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what these tests assert */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import FullScreenPresentationViewer from "./full-screen-presentation-viewer";

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("./slide-editor-dialog", () => {
    return { default: () => null };
});
vi.mock("../lib/slide-html-template", () => {
    return { createSlideHtml: () => "<p>slide</p>", SLIDE_HEIGHT: 1080, SLIDE_WIDTH: 1920 };
});

const slides = [
    { _id: "s1", htmlContent: "<p>1</p>", slideNumber: 1, title: "One" },
    { _id: "s2", htmlContent: "<p>2</p>", slideNumber: 2, title: "Two" },
];

const Harness = () => {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)} type="button">
                Open slides
            </button>
            <button type="button">Behind the viewer</button>
            <FullScreenPresentationViewer isOpen={open} onClose={() => setOpen(false)} presentationTitle="Roadmap" slides={slides} />
        </>
    );
};

describe("full-screen presentation viewer focus management", () => {
    it("is a named modal dialog that takes focus on open", () => {
        render(<Harness />);
        const opener = screen.getByRole("button", { name: "Open slides" });

        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole("dialog", { name: "Roadmap" });

        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(document.activeElement).toBe(dialog);
    });

    it("keeps Tab and Shift+Tab inside the dialog", () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "Open slides" }));
        const dialog = screen.getByRole("dialog");
        const inside = [...dialog.querySelectorAll<HTMLElement>("button")];
        const last = inside.at(-1) as HTMLElement;
        const first = inside.at(0) as HTMLElement;

        last.focus();
        expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
        expect(document.activeElement).toBe(first);

        expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(last);

        // Focus that slipped out onto the page is pulled back in rather than reaching the content behind.
        (document.activeElement as HTMLElement).blur();
        expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(false);
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("lets Space activate a focused button instead of turning the slide", () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "Open slides" }));
        const close = screen.getByRole("button", { name: "Close full screen" });

        close.focus();

        expect(fireEvent.keyDown(close, { key: " " })).toBe(true);
    });

    it("restores focus to the opener on Escape", () => {
        render(<Harness />);
        const opener = screen.getByRole("button", { name: "Open slides" });

        opener.focus();
        fireEvent.click(opener);
        expect(screen.getByRole("dialog")).toBeTruthy();

        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(opener);
    });
});
