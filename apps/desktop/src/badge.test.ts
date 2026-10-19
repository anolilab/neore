import { describe, expect, it, vi } from "vitest";

import { isTrustedUrl } from "./trust.js";
import { clampBadgeCount, createSetBadgeHandler, MAX_BADGE_COUNT } from "./badge.js";

const origin = new URL("https://neore.ai");
const sender = (url: string | undefined) => ({ senderFrame: url === undefined ? undefined : { url } });

const setup = (platform: NodeJS.Platform = "darwin") => {
    const setBadgeCount = vi.fn();
    const handle = createSetBadgeHandler({ isTrusted: (event) => isTrustedUrl(origin, event.senderFrame?.url), platform, setBadgeCount });

    return { handle, setBadgeCount };
};

describe("clampBadgeCount", () => {
    it.each([
        [0, 0],
        [7, 7],
        [3.9, 3],
        [-5, 0],
        [MAX_BADGE_COUNT, 999],
        [1500, 999],
    ])("maps %s to %s", (input, expected) => {
        expect(clampBadgeCount(input)).toBe(expected);
    });

    it.each([["5"], [undefined], [null], [Number.NaN], [Number.POSITIVE_INFINITY]])("refuses %s", (input) => {
        expect(() => clampBadgeCount(input)).toThrow(TypeError);
    });
});

describe("createSetBadgeHandler", () => {
    it("accepts a call from the site origin and sets the clamped count", () => {
        const { handle, setBadgeCount } = setup();

        handle(sender("https://neore.ai/chat"), 4000);

        expect(setBadgeCount).toHaveBeenCalledWith(999);
    });

    it("refuses another origin, and a sender with no frame, without touching the badge", () => {
        const { handle, setBadgeCount } = setup();

        expect(() => handle(sender("https://evil.example/chat"), 3)).toThrow("untrusted sender");
        expect(() => handle(sender("https://neore.ai.evil.example/"), 3)).toThrow("untrusted sender");
        expect(() => handle(sender(undefined), 3)).toThrow("untrusted sender");
        expect(setBadgeCount).not.toHaveBeenCalled();
    });

    it("checks the sender before the payload", () => {
        const { handle } = setup();

        expect(() => handle(sender("https://evil.example/"), "not a number")).toThrow("untrusted sender");
    });

    it("does nothing on Windows, where the badge is not set", () => {
        const { handle, setBadgeCount } = setup("win32");

        handle(sender("https://neore.ai/"), 2);

        expect(setBadgeCount).not.toHaveBeenCalled();
    });

    it("sets the badge on Linux too", () => {
        const { handle, setBadgeCount } = setup("linux");

        handle(sender("https://neore.ai/"), 0);

        expect(setBadgeCount).toHaveBeenCalledWith(0);
    });
});
