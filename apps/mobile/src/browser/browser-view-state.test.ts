import { describe, expect, it } from "vitest";

import type { BrowserStatus } from "./browser-api";
import {
    BROWSER_CLOSED,
    browserLinkUntil,
    CONTROLLED_BY_OTHER,
    expiredReread,
    frameMessage,
    frameTrigger,
    GRANT_END_MARGIN_MS,
    grantEndOnDevice,
    isOlderStatus,
    isRateLimited,
    isReadDue,
    LOAD_FAILED,
    NO_BROWSER,
    NOT_READABLE,
    otherLeaseEndOnDevice,
    shouldReadFrame,
    viewStateOf,
    withAnswer,
} from "./browser-view-state";

const running = (fields: Partial<Extract<BrowserStatus, { kind: "running" }>> = {}): BrowserStatus => {
    return { browserId: "b-1", canControl: true, currentUrl: "https://example.com", idleUntil: 500, kind: "running", now: 100, ...fields };
};

describe(viewStateOf, () => {
    it("shows each state on its own: connecting, ready, no browser, not readable, someone else in control", () => {
        expect(viewStateOf(undefined, undefined)).toStrictEqual({ kind: "connecting" });
        expect(viewStateOf(undefined, undefined, { isLoadFailed: true })).toStrictEqual({ kind: "failed", message: LOAD_FAILED });
        // A failure after a status was read leaves the page shown.
        expect(viewStateOf(running(), undefined, { isLoadFailed: true }).kind).toBe("ready");
        expect(viewStateOf(running(), undefined)).toStrictEqual({ canControl: true, currentUrl: "https://example.com", kind: "ready" });
        expect(viewStateOf({ kind: "none", now: 1 }, undefined)).toStrictEqual({ kind: "ended", message: NO_BROWSER });
        expect(viewStateOf({ kind: "denied", now: 1 }, undefined)).toStrictEqual({ kind: "ended", message: NOT_READABLE });
        expect(viewStateOf(undefined, "NOT_FOUND")).toStrictEqual({ kind: "ended", message: NOT_READABLE });
        expect(viewStateOf(running({ control: { byYou: false, until: 200 } }), undefined)).toStrictEqual({ kind: "hidden", message: CONTROLLED_BY_OTHER });
    });

    it("shows a browser a frame read found gone as closed, until the status names another", () => {
        expect(viewStateOf(running(), undefined, { closedBrowserId: "b-1" })).toStrictEqual({ kind: "ended", message: BROWSER_CLOSED });
        expect(viewStateOf(running({ browserId: "b-2" }), undefined, { closedBrowserId: "b-1" }).kind).toBe("ready");
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

        // Early by the margin: the answer's way here must not keep the page up past the end.
        expect(grantEndOnDevice(status, 5000)).toBe(5060 - GRANT_END_MARGIN_MS);
        expect(grantEndOnDevice(running(), 5000)).toBeUndefined();
        expect(viewStateOf(status, undefined, { isExpired: true })).toStrictEqual({ kind: "ended", message: NOT_READABLE });
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

describe(otherLeaseEndOnDevice, () => {
    it("names when another person's lease ends on this device's clock, so the page is read again then", () => {
        expect(otherLeaseEndOnDevice(running({ control: { byYou: false, until: 160 }, now: 100 }), 5000)).toBe(5060);
        expect(otherLeaseEndOnDevice(running({ control: { byYou: true, until: 160 }, now: 100 }), 5000)).toBeUndefined();
        expect(otherLeaseEndOnDevice(running({ control: { byYou: false, until: 100 }, now: 100 }), 5000)).toBeUndefined();
        expect(otherLeaseEndOnDevice(running(), 5000)).toBeUndefined();
    });
});

describe(withAnswer, () => {
    it("never lets a read begun before a refusal undo it, but a later answer clears it", () => {
        const refused = { answer: { receivedAt: 10, status: running() }, refusal: { at: 50, message: "NOT_FOUND" } };

        // A one-shot read that began before the refusal answers after it: the refusal stands.
        expect(withAnswer(refused, running({ now: 200 }), 40, 60)).toBe(refused);
        // A push after the refusal says the chat reads again.
        expect(withAnswer(refused, running({ now: 200 }), 60, 60)).toStrictEqual({ answer: { receivedAt: 60, status: running({ now: 200 }) } });
    });

    it("keeps the answer on screen over an older one", () => {
        const seen = { answer: { receivedAt: 10, status: running({ now: 300 }) } };

        expect(withAnswer(seen, running({ now: 200 }), 20, 20)).toBe(seen);
    });
});

describe(isRateLimited, () => {
    it("tells a read refused for the rate limit from any other failure", () => {
        expect(isRateLimited({ code: "TOO_MANY_REQUESTS", message: "Slow down" })).toBe(true);
        expect(isRateLimited({ data: { code: "TOO_MANY_REQUESTS" }, message: "Slow down" })).toBe(true);
        expect(isRateLimited({ code: "FORBIDDEN" })).toBe(false);
        expect(isRateLimited(new TypeError("Network request failed"))).toBe(false);
        expect(isRateLimited(undefined)).toBe(false);
    });
});

describe(browserLinkUntil, () => {
    it("shows the link until the browser goes idle, for a reader until the grant ends if sooner, and never otherwise", () => {
        // `running()`: idle at 500 on the server's clock, read at 100.
        expect(browserLinkUntil(running(), 5000)).toBe(5400);
        expect(browserLinkUntil(running({ accessUntil: 160, now: 100 }), 5000)).toBe(5060 - GRANT_END_MARGIN_MS);
        expect(browserLinkUntil(running({ accessUntil: 100_000, now: 100 }), 5000)).toBe(5400);
        expect(browserLinkUntil({ kind: "none", now: 100 } as BrowserStatus, 5000)).toBeUndefined();
    });
});

describe(isReadDue, () => {
    it("asks for a read on a changed key only: not the first key after a mount, nor the same key again", () => {
        expect(isReadDue(undefined, "b-1|500|https://example.com|0")).toBe(false);
        expect(isReadDue("b-1|500|https://example.com|0", "b-1|500|https://example.com|0")).toBe(false);
        expect(isReadDue("b-1|500|https://example.com|0", "b-1|600|https://example.com|0")).toBe(true);
        expect(isReadDue("b-1|500|https://example.com|0", "b-1|500|https://example.com|1")).toBe(true);
    });
});

describe(expiredReread, () => {
    it("reads an expired grant again only on a tick after the one it ran out at", () => {
        // The tick it ran out at is kept, and reads nothing: the end's own read is timed.
        expect(expiredReread(undefined, 3)).toStrictEqual({ expiredAt: 3, isDue: false });
        expect(expiredReread(3, 3)).toStrictEqual({ expiredAt: 3, isDue: false });
        // Every later tick reads again, the expiry tick kept.
        expect(expiredReread(3, 4)).toStrictEqual({ expiredAt: 3, isDue: true });
        expect(expiredReread(3, 5)).toStrictEqual({ expiredAt: 3, isDue: true });
    });
});
