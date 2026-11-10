import { describe, expect, it } from "vitest";

import { GUEST_POLL_MS, guestPollInterval } from "./guest-poll";

describe(guestPollInterval, () => {
    it("polls while a note waits, and stops once every note is sent or the link answers nothing", () => {
        expect(guestPollInterval({ messages: [{ status: "sent" }, { status: "held" }] })).toBe(GUEST_POLL_MS);
        expect(guestPollInterval({ messages: [{ status: "sent" }] })).toBe(false);
        expect(guestPollInterval({ messages: [] })).toBe(false);
        expect(guestPollInterval(null)).toBe(false);
    });
});
