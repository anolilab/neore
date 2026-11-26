import { describe, expect, it } from "vitest";

import type { BrowserStatus } from "./browser-api";
import {
    CONTROLLED_BY_OTHER,
    frameMessage,
    frameTrigger,
    grantEndOnDevice,
    isOlderStatus,
    NO_BROWSER,
    NOT_READABLE,
    shouldReadFrame,
    viewStateOf,
} from "./browser-view-state";

const running = (fields: Partial<Extract<BrowserStatus, { kind: "running" }>> = {}): BrowserStatus => {
    return { browserId: "b-1", canControl: true, currentUrl: "https://example.com", idleUntil: 500, kind: "running", now: 100, ...fields };
};

describe(viewStateOf, () => {
    it("shows each state on its own: connecting, ready, no browser, not readable, someone else in control", () => {
        expect(viewStateOf(undefined, undefined)).toStrictEqual({ kind: "connecting" });
        expect(viewStateOf(running(), undefined)).toStrictEqual({ canControl: true, currentUrl: "https://example.com", kind: "ready" });
        expect(viewStateOf({ kind: "none", now: 1 }, undefined)).toStrictEqual({ kind: "ended", message: NO_BROWSER });
        expect(viewStateOf({ kind: "denied", now: 1 }, undefined)).toStrictEqual({ kind: "ended", message: NOT_READABLE });
        expect(viewStateOf(undefined, "NOT_FOUND")).toStrictEqual({ kind: "ended", message: NOT_READABLE });
        expect(viewStateOf(running({ control: { byYou: false, until: 200 } }), undefined)).toStrictEqual({ kind: "hidden", message: CONTROLLED_BY_OTHER });
    });

    it("shows the page again once another person's lease ran out on the server's clock, and to the person who holds it", () => {
        expect(viewStateOf(running({ control: { byYou: false, until: 100 } }), undefined).kind).toBe("ready");
        expect(viewStateOf(running({ control: { byYou: true, until: 200 } }), undefined).kind).toBe("ready");
    });

    it("tells a read-only reader apart, so the control button is not offered", () => {
        expect(viewStateOf(running({ canControl: false }), undefined)).toMatchObject({ canControl: false, kind: "ready" });
    });
});

describe(frameTrigger, () => {
    it("moves on an agent action, a new page and a replaced browser, and not otherwise", () => {
        const base = frameTrigger(running());

        expect(frameTrigger(running())).toBe(base);
        expect(frameTrigger(running({ idleUntil: 600 }))).not.toBe(base);
        expect(frameTrigger(running({ currentUrl: "https://example.com/next" }))).not.toBe(base);
        expect(frameTrigger(running({ browserId: "b-2" }))).not.toBe(base);
        expect(frameTrigger({ kind: "none", now: 1 })).toBeUndefined();
    });
});

describe(shouldReadFrame, () => {
    it("reads frames only for a page on screen, in front, online", () => {
        const ready = viewStateOf(running(), undefined);

        expect(shouldReadFrame(ready, { isActive: true, isOffline: false })).toBe(true);
        expect(shouldReadFrame(ready, { isActive: false, isOffline: false })).toBe(false);
        expect(shouldReadFrame(ready, { isActive: true, isOffline: true })).toBe(false);
        expect(shouldReadFrame({ kind: "hidden", message: "" }, { isActive: true, isOffline: false })).toBe(false);
    });
});

describe(frameMessage, () => {
    it("says why no picture came, and nothing for one that did", () => {
        expect(frameMessage({ image: "x", status: "ok", takenAt: 1 })).toBeUndefined();
        expect(frameMessage({ status: "controlled" })).toBe(CONTROLLED_BY_OTHER);
        expect(frameMessage({ status: "ended" })).toBe("The browser has closed.");
        expect(frameMessage({ status: "unavailable" })).toBe("The page could not be shown right now.");
    });
});

describe("a grantee's answers", () => {
    it("stops showing the page once the grant ran out, on this device's clock", () => {
        const status = running({ accessUntil: 160, now: 100 });

        expect(grantEndOnDevice(status, 5000)).toBe(5060);
        expect(grantEndOnDevice(running(), 5000)).toBeUndefined();
        expect(viewStateOf(status, undefined, true)).toStrictEqual({ kind: "ended", message: NOT_READABLE });
    });

    it("never lets an older grant's answer replace a newer denial", () => {
        const denied: BrowserStatus = { kind: "denied", now: 200, revision: 3 };

        // A lagging read of the grant since removed: an older revision, even on a later clock.
        expect(isOlderStatus(denied, running({ now: 300, revision: 2 }))).toBe(true);
        // A renewal advances the revision.
        expect(isOlderStatus(denied, running({ now: 300, revision: 4 }))).toBe(false);
        // The same revision: the server's clock decides, and a denial holds against an answer from the same moment.
        expect(isOlderStatus(running({ now: 200 }), running({ now: 150 }))).toBe(true);
        expect(isOlderStatus({ kind: "denied", now: 200 }, running({ now: 200 }))).toBe(true);
        expect(isOlderStatus(undefined, running())).toBe(false);
    });
});

describe("frame reads while the phone holds control", () => {
    it("are not spent on the phone's own renewals, which move only the activity clock", () => {
        expect(frameTrigger(running({ idleUntil: 600 }), true)).toBe(frameTrigger(running(), true));
        expect(frameTrigger(running({ currentUrl: "https://example.com/next" }), true)).not.toBe(frameTrigger(running(), true));
    });
});
