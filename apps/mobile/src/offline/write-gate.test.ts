import { describe, expect, it, vi } from "vitest";

import { CHECKING_REASON, OFFLINE_REASON, OfflineWriteError, requireOnline, WRITE_CONTROLS, writeControlState } from "./write-gate";

describe("writeControlState", () => {
    it("disables every write control while offline and says why", () => {
        for (const control of WRITE_CONTROLS) {
            const state = writeControlState(control, { isOffline: true });

            expect(state.disabled, control).toBe(true);
            expect(state.reason, control).toBe(OFFLINE_REASON);
        }
    });

    it("covers the composer, send, approve, cancel and start controls", () => {
        expect([...WRITE_CONTROLS].toSorted((a, b) => a.localeCompare(b))).toEqual(["approve", "cancel", "composer", "send", "start"]);
    });

    it("keeps them disabled while a returning connection is being confirmed, with its own reason", () => {
        for (const control of WRITE_CONTROLS) {
            expect(writeControlState(control, { isChecking: true, isOffline: false }), control).toEqual({ disabled: true, reason: CHECKING_REASON });
        }
    });

    it("enables them online with no reason", () => {
        for (const control of WRITE_CONTROLS) {
            expect(writeControlState(control, { isOffline: false })).toEqual({ disabled: false, reason: undefined });
        }
    });
});

describe("requireOnline", () => {
    it("refuses a write offline without calling it", async () => {
        const send = vi.fn(async () => "sent");

        await expect(requireOnline({ isOffline: true }, send)).rejects.toBeInstanceOf(OfflineWriteError);
        expect(send).not.toHaveBeenCalled();
    });

    it("runs a write online", async () => {
        const send = vi.fn(async () => "sent");

        await expect(requireOnline({ isOffline: false }, send)).resolves.toBe("sent");
        expect(send).toHaveBeenCalledTimes(1);
    });
});
