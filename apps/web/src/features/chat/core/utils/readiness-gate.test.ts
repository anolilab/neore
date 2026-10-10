import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadinessGate } from "./readiness-gate";

describe("createReadinessGate", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("resolves at once when already ready", async () => {
        await expect(createReadinessGate(true).wait(1000)).resolves.toBe(true);
    });

    it("holds a send until the session lands, instead of dropping it", async () => {
        const gate = createReadinessGate();
        const waiting = gate.wait(10_000);

        await vi.advanceTimersByTimeAsync(2000);
        gate.set(true);

        await expect(waiting).resolves.toBe(true);
    });

    it("gives up after the timeout so the caller can restore the composer", async () => {
        const gate = createReadinessGate();
        const waiting = gate.wait(10_000);

        await vi.advanceTimersByTimeAsync(10_000);

        await expect(waiting).resolves.toBe(false);

        // A late session does not resurrect a waiter that already gave up.
        gate.set(true);
        expect(gate.isReady()).toBe(true);
    });

    it("does not wake waiters when flipped to not-ready", async () => {
        const gate = createReadinessGate();
        const waiting = gate.wait(1000);

        gate.set(false);
        await vi.advanceTimersByTimeAsync(1000);

        await expect(waiting).resolves.toBe(false);
    });
});
