// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import useFocusTrap from "./use-focus-trap";

const Harness = () => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useFocusTrap(ref, { active: open, onEscape: () => setOpen(false) });

    return (
        <>
            <button onClick={() => setOpen(true)} type="button">
                opener
            </button>
            <div aria-label="panel" ref={ref} role="dialog" tabIndex={-1}>
                <button type="button">first</button>
                <button disabled type="button">
                    disabled
                </button>
                <button tabIndex={-1} type="button">
                    skipped
                </button>
                <button type="button">last</button>
            </div>
        </>
    );
};

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const cleanups: (() => void)[] = [];

const mount = () => {
    const container = document.createElement("div");

    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<Harness />));
    cleanups.push(() => {
        act(() => root.unmount());
        container.remove();
    });

    const byName = (name: string) => [...container.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === name) as HTMLElement;

    return { byName, dialog: container.querySelector('[role="dialog"]') as HTMLElement };
};

/** Dispatches a cancelable keydown and reports whether it was left alone (not default-prevented). */
const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean => {
    let notPrevented = true;

    act(() => {
        notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
    });

    return notPrevented;
};

describe("useFocusTrap", () => {
    afterEach(() => {
        for (const cleanup of cleanups) {
            cleanup();
        }

        cleanups.length = 0;
    });

    it("moves focus in, wraps Tab over tabbable controls only, and gives focus back on Escape", () => {
        const { byName, dialog } = mount();
        const opener = byName("opener");
        const first = byName("first");
        const last = byName("last");

        opener.focus();
        act(() => opener.click());
        expect(document.activeElement).toBe(dialog);

        last.focus();
        expect(press(last, "Tab")).toBe(false);
        expect(document.activeElement).toBe(first);

        expect(press(first, "Tab", { shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(last);

        // Tab between two inner controls is left to the browser.
        expect(press(first, "Tab")).toBe(true);

        press(first, "Escape");
        expect(document.activeElement).toBe(opener);
    });

    it("ignores Escape that something inside already handled", () => {
        const { byName, dialog } = mount();

        act(() => byName("opener").click());
        const first = byName("first");

        first.addEventListener("keydown", (event) => event.preventDefault());
        press(first, "Escape");

        expect(document.activeElement).toBe(dialog);
    });

    it("stops intercepting Tab once its container left the page while still active", () => {
        const { byName, dialog } = mount();

        act(() => byName("opener").click());
        dialog.parentElement?.remove();

        expect(press(document.body, "Tab")).toBe(true);
    });
});
