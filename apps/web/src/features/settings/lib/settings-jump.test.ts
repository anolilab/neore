import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findSettingsRow, HIGHLIGHT_DURATION_MS, jumpToSettingsRow, SETTLE_MS, WAIT_FOR_ROW_MS } from "./settings-jump";

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

    it("takes the smallest wrapper holding a plain label and the control it names", () => {
        const root = mount(
            '<div id="outer"><div id="row"><div id="text"><label for="tz">Timezone</label><p>desc</p></div><select id="tz"></select></div><p>other</p></div>',
        );

        expect(findSettingsRow(root, "Timezone")?.id).toBe("row");
    });

    it("follows aria-labelledby to the control", () => {
        const root = mount('<div id="row"><div><span id="name" role="heading">Backup</span></div><button aria-labelledby="name" type="button"></button></div>');

        expect(findSettingsRow(root, "Backup")?.id).toBe("row");
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
        expect(row?.classList.contains("outline-2")).toBe(true);

        vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);

        expect(row?.classList.contains("outline-2")).toBe(false);
    });

    it("leaves a card's own rounding and ring alone, and scrolls a card to its top", () => {
        const root = mount('<div class="rounded-lg ring-1 outline-2" data-slot="card" id="card"><div data-slot="card-title">Memory</div></div>');

        jumpToSettingsRow(root, "Memory");

        const card = root.querySelector("#card");

        expect(card?.classList.contains("outline-primary")).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });

        vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);

        expect([...(card?.classList ?? [])]).toEqual(["rounded-lg", "ring-1", "outline-2"]);
    });

    it("hands the row's control to onReveal once", () => {
        const root = mount('<div><label for="tz">Timezone</label><select id="tz"></select></div>');
        const onReveal = vi.fn();

        jumpToSettingsRow(root, "Timezone", onReveal);

        expect(onReveal).toHaveBeenCalledTimes(1);
        expect(onReveal).toHaveBeenCalledWith(root.querySelector("#tz"));
    });

    it("scrolls again when content above the row shifts it just after the first scroll", async () => {
        const root = mount('<div id="row"><label>Timezone</label></div>');
        const top = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

        top.mockReturnValue({ top: 100 } as DOMRect);
        jumpToSettingsRow(root, "Timezone");
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        top.mockReturnValue({ top: 340 } as DOMRect);
        root.insertAdjacentHTML("afterbegin", "<p>late content</p>");
        await Promise.resolve();

        expect(scrollIntoView).toHaveBeenCalledTimes(2);

        // Past the settle window the view is the user's.
        vi.advanceTimersByTime(SETTLE_MS);
        top.mockReturnValue({ top: 500 } as DOMRect);
        root.insertAdjacentHTML("afterbegin", "<p>later content</p>");
        await Promise.resolve();

        expect(scrollIntoView).toHaveBeenCalledTimes(2);
        top.mockRestore();
    });

    it("stops waiting when the user scrolls the tab", async () => {
        const root = mount("");

        jumpToSettingsRow(root, "Timezone");
        root.dispatchEvent(new Event("wheel"));
        root.innerHTML = '<div id="row"><label>Timezone</label></div>';
        await Promise.resolve();

        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("keeps waiting well past the old four seconds, and gives up after a longer one", async () => {
        const root = mount("");

        jumpToSettingsRow(root, "Timezone");
        vi.advanceTimersByTime(WAIT_FOR_ROW_MS - 1);
        root.innerHTML = '<div id="row"><label>Timezone</label></div>';
        await Promise.resolve();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        const late = mount("");

        jumpToSettingsRow(late, "Timezone");
        vi.advanceTimersByTime(WAIT_FOR_ROW_MS);
        late.innerHTML = '<div id="row"><label>Timezone</label></div>';
        await Promise.resolve();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
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

        expect(root.querySelector("#row")?.classList.contains("outline-2")).toBe(false);

        const waiting = mount("");
        const cancelWaiting = jumpToSettingsRow(waiting, "Timezone");

        cancelWaiting();
        waiting.innerHTML = "<div><label>Timezone</label></div>";
        await Promise.resolve();

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
});
