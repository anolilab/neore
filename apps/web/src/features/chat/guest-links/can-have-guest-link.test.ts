import { describe, expect, it } from "vitest";

import { canHaveGuestLink } from "./can-have-guest-link";

describe(canHaveGuestLink, () => {
    it("shows no tab before the thread is loaded, whatever else has answered", () => {
        expect(canHaveGuestLink(undefined, true)).toBe(false);
        expect(canHaveGuestLink(null, true)).toBe(false);
    });

    it("shows the tab for an ordinary chat known not to be a worker's, and not for a temporary, archived or host-run one", () => {
        expect(canHaveGuestLink({ status: "active" }, true)).toBe(true);
        expect(canHaveGuestLink({ status: "active" }, false)).toBe(false);
        expect(canHaveGuestLink({ isTemporary: true, status: "active" }, true)).toBe(false);
        expect(canHaveGuestLink({ status: "archived" }, true)).toBe(false);
        expect(canHaveGuestLink({ runner: "host", status: "active" }, true)).toBe(false);
    });
});
