import { afterEach, describe, expect, it } from "vitest";

import { focusAreaIndexOf, focusNextArea, nextFocusAreaIndex, trackFocusedArea } from "./focus-areas";

describe("nextFocusAreaIndex", () => {
    it("steps forward and back through the areas, wrapping at both ends", () => {
        expect(nextFocusAreaIndex(4, 0, 1)).toBe(1);
        expect(nextFocusAreaIndex(4, 3, 1)).toBe(0);
        expect(nextFocusAreaIndex(4, 0, -1)).toBe(3);
    });

    it("starts at the first area going forward and the last going back when no area holds focus", () => {
        expect(nextFocusAreaIndex(4, -1, 1)).toBe(0);
        expect(nextFocusAreaIndex(4, -1, -1)).toBe(3);
    });

    it("has nothing to move to without areas", () => {
        expect(nextFocusAreaIndex(0, -1, 1)).toBe(-1);
    });
});

describe("focusAreaIndexOf", () => {
    const mounted: HTMLElement[] = [];

    afterEach(() => {
        for (const element of mounted) {
            element.remove();
        }

        mounted.length = 0;
    });

    const area = (parent?: HTMLElement): HTMLElement => {
        const element = document.createElement("div");

        const host: HTMLElement = parent ?? document.body;

        host.appendChild(element);
        mounted.push(element);

        return element;
    };

    it("picks the innermost area that holds the focus, so a composer inside the thread counts as the composer", () => {
        const thread = area();
        const composer = area(thread);
        const panel = area();
        const input = document.createElement("textarea");

        composer.appendChild(input);

        expect(focusAreaIndexOf([thread, composer, panel], input)).toBe(1);
        expect(focusAreaIndexOf([thread, composer, panel], panel)).toBe(2);
        expect(focusAreaIndexOf([thread, composer, panel], document.body)).toBe(-1);
    });
});

describe("focusNextArea", () => {
    const mounted: HTMLElement[] = [];

    // In jsdom nothing is laid out, so an element counts as shown only once it has a box.
    const giveBox = (element: HTMLElement): HTMLElement => {
        const box = {
            bottom: 10,
            height: 10,
            left: 0,
            right: 10,
            top: 0,
            width: 10,
            x: 0,
            y: 0,
            toJSON: () => {
                return {};
            },
        };

        return Object.assign(element, {
            getBoundingClientRect: (): DOMRect => box as DOMRect,
            getClientRects: (): DOMRectList => [box] as unknown as DOMRectList,
        });
    };

    const area = (parent: HTMLElement = document.body): HTMLElement => {
        const element = giveBox(document.createElement("section"));

        element.dataset.focusArea = "";
        element.tabIndex = 0;
        parent.appendChild(element);
        mounted.push(element);

        return element;
    };

    afterEach(() => {
        for (const element of mounted) {
            element.remove();
        }

        mounted.length = 0;
    });

    it("moves through the page's areas in order and reports that it moved", () => {
        const first = area();
        const second = area();

        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(first);
        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(second);
    });

    it("reports no move when the only area already holds the focus, in either direction", () => {
        const only = area();

        only.focus();
        expect(focusNextArea(1)).toBe(false);
        expect(focusNextArea(-1)).toBe(false);
        expect(document.activeElement).toBe(only);
    });

    it("moves focus into the only area when focus is outside it", () => {
        const only = area();

        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(only);
    });

    it("stays inside an open dialog and never visits an area behind it", () => {
        const behind = area();
        const dialog = giveBox(document.createElement("div"));

        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        document.body.appendChild(dialog);
        mounted.push(dialog);

        const inside = area(dialog);

        behind.focus();
        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(inside);
        // The dialog's only area holds the focus now: nothing moves, so the browser keeps the key.
        expect(focusNextArea(1)).toBe(false);
        expect(document.activeElement).toBe(inside);
    });

    it("cycles the controls of an open dialog that has no area, so a fullscreen viewer keeps F6 and its controls", () => {
        area();
        const dialog = giveBox(document.createElement("div"));
        const first = giveBox(document.createElement("button"));
        const second = giveBox(document.createElement("button"));

        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        first.textContent = "Previous slide";
        second.textContent = "Next slide";
        dialog.appendChild(first);
        dialog.appendChild(second);
        document.body.appendChild(dialog);
        mounted.push(dialog);

        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(first);
        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(second);
        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(first);
        expect(focusNextArea(-1)).toBe(true);
        expect(document.activeElement).toBe(second);
    });

    it("reports nothing to move to when the open dialog has no area and no control, so the browser keeps its own F6", () => {
        area();
        const dialog = giveBox(document.createElement("div"));

        dialog.setAttribute("role", "dialog");
        document.body.appendChild(dialog);
        mounted.push(dialog);

        expect(focusNextArea(1)).toBe(false);
    });

    it("ignores an open popover, so F6 keeps moving through the page's areas while its picker has focus", () => {
        const first = area();
        const popover = giveBox(document.createElement("div"));

        popover.setAttribute("role", "dialog");
        popover.dataset.slot = "popover-content";
        popover.tabIndex = -1;
        document.body.appendChild(popover);
        mounted.push(popover);
        popover.focus();

        expect(focusNextArea(1)).toBe(true);
        expect(document.activeElement).toBe(first);
    });

    it("continues from the area a popup was opened from, when focus is in a popup portaled out of it", () => {
        const sidebar = area();
        const thread = area();
        const popup = giveBox(document.createElement("div"));

        popup.setAttribute("role", "menu");
        popup.tabIndex = -1;
        document.body.appendChild(popup);
        mounted.push(popup);
        document.addEventListener("focusin", trackFocusedArea);

        try {
            expect(focusNextArea(1)).toBe(true);
            expect(document.activeElement).toBe(sidebar);
            sidebar.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

            popup.focus();
            expect(focusNextArea(1)).toBe(true);
            expect(document.activeElement).toBe(thread);
        } finally {
            document.removeEventListener("focusin", trackFocusedArea);
        }
    });
});
