import { describe, expect, it } from "vitest";

import { attachCountWithinCap, attachWindowOpen, FILE_ATTACH_SAVE_MARGIN_MS, FILE_ATTACH_TTL_MS, MAX_ATTACHED_FILES } from "./file-attach-claim";

describe("attachWindowOpen", () => {
    const claimedAt = 1_000_000;
    const closesAt = claimedAt + FILE_ATTACH_TTL_MS - FILE_ATTACH_SAVE_MARGIN_MS;

    it("is open right after the claim is taken", () => {
        expect(attachWindowOpen(claimedAt, claimedAt)).toBe(true);
    });

    it("is open just before the window closes", () => {
        expect(attachWindowOpen(claimedAt, closesAt - 1)).toBe(true);
    });

    it("is closed from the moment the window closes, so a save never starts inside the claim's last margin", () => {
        expect(attachWindowOpen(claimedAt, closesAt)).toBe(false);
        expect(attachWindowOpen(claimedAt, claimedAt + FILE_ATTACH_TTL_MS)).toBe(false);
    });
});

describe("attachCountWithinCap", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `file-${index}`);

    it("allows a message up to the cap", () => {
        expect(attachCountWithinCap(ids(MAX_ATTACHED_FILES))).toBe(true);
    });

    it("refuses a message one file over the cap", () => {
        expect(attachCountWithinCap(ids(MAX_ATTACHED_FILES + 1))).toBe(false);
    });
});
