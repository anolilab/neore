import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findSettingsRow, HIGHLIGHT_DURATION_MS, jumpToSettingsRow } from "./settings-jump";

const scrollIntoView = vi.fn();

const mount = (html: string): HTMLElement => {
    const root = document.createElement("div");

    root.innerHTML = html;
    document.body.insertAdjacentElement("beforeend", root);

    return root;
};

beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
});

afterEach(() => {
    vi.useRealTimers();
    scrollIntoView.mockReset();
    document.body.replaceChildren();
});

describe("findSettingsRow", () => {
    it("matches a form label's row ignoring case and accents", () => {
        const root = mount('<div id="row"><label>Fuseau Horaire</label><p>desc</p></div>');

        expect(findSettingsRow(root, "FUSEAU horaire")?.id).toBe("row");
    });

    it("returns the whole card for a card title and the field for a field label", () => {
        const root = mount(
            '<div data-slot="card" id="card"><div data-slot="card-title">Memory</div><div data-slot="field" id="field"><label>Nickname</label></div></div>',
        );

        expect(findSettingsRow(root, "Memory")?.id).toBe("card");
        expect(findSettingsRow(root, "Nickname")?.id).toBe("field");
    });

    it("finds nothing for a title that is not there", () => {
        expect(findSettingsRow(mount("<label>Nickname</label>"), "Profession")).toBeNull();
    });
});

describe("jumpToSettingsRow", () => {
    it("scrolls to a row that is already there and rings it for two seconds", () => {
        const root = mount('<div id="row"><label>Timezone</label></div>');

        jumpToSettingsRow(root, "Timezone");

        const row = root.querySelector("#row");

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(row?.classList.contains("ring-2")).toBe(true);

        vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);

        expect(row?.classList.contains("ring-2")).toBe(false);
    });

    it("waits for a lazy tab to render the row", async () => {
        const root = mount("");

        jumpToSettingsRow(root, "Timezone");
        expect(scrollIntoView).not.toHaveBeenCalled();

        root.innerHTML = '<div id="row"><label>Timezone</label></div>';
        // MutationObserver callbacks run as microtasks.
        await Promise.resolve();

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("clears the ring when cancelled, and stops waiting", async () => {
        const root = mount('<div id="row"><label>Timezone</label></div>');
        const cancel = jumpToSettingsRow(root, "Timezone");

        cancel();

        expect(root.querySelector("#row")?.classList.contains("ring-2")).toBe(false);

        const waiting = mount("");
        const cancelWaiting = jumpToSettingsRow(waiting, "Timezone");

        cancelWaiting();
        waiting.innerHTML = "<div><label>Timezone</label></div>";
        await Promise.resolve();

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
});
