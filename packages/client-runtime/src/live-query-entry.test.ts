import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Entry, NO_VALUE } from "./live-query-entry";

const create = () => new Entry("x:y", {}, ["lunora", "x:y", {}, null]);

describe(Entry, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("moves queued → seeding → settled, reporting the slot once", () => {
        const entry = create();

        expect(entry.state).toBe("queued");
        expect(entry.settle()).toBe(false);
        expect(entry.beginSeeding(1000, () => {})).toBe(true);
        expect(entry.beginSeeding(1000, () => {})).toBe(false);
        expect(entry.state).toBe("seeding");
        expect(entry.settle()).toBe(true);
        expect(entry.settle()).toBe(false);
        expect(entry.state).toBe("settled");
    });

    it("fires the slot timeout only while seeding", () => {
        const onTimeout = vi.fn();
        const entry = create();

        entry.beginSeeding(1000, onTimeout);
        entry.settle();
        vi.advanceTimersByTime(1000);

        expect(onTimeout).not.toHaveBeenCalled();
    });

    it("reports the held slot when closed mid-seed, and not on a second close", () => {
        const entry = create();

        entry.beginSeeding(1000, () => {});

        expect(entry.close()).toBe(true);
        expect(entry.close()).toBe(false);
        expect(entry.state).toBe("closed");
        expect(entry.beginSeeding(1000, () => {})).toBe(false);
    });

    it("unsubscribes once on close, and at once when attached after close", () => {
        const first = vi.fn();
        const entry = create();

        entry.attach(first);
        entry.close();
        entry.close();

        expect(first).toHaveBeenCalledTimes(1);

        const late = vi.fn();

        entry.attach(late);

        expect(late).toHaveBeenCalledTimes(1);
    });

    it("lingers once, and stops lingering on demand or on close", () => {
        const onExpire = vi.fn();
        const entry = create();

        entry.linger(1000, onExpire);
        entry.linger(1000, onExpire);

        expect(entry.isLingering).toBe(true);

        entry.stopLingering();
        vi.advanceTimersByTime(1000);

        expect(onExpire).not.toHaveBeenCalled();

        entry.linger(1000, onExpire);
        entry.close();
        vi.advanceTimersByTime(1000);

        expect(onExpire).not.toHaveBeenCalled();
        expect(entry.isLingering).toBe(false);
    });

    it("resolves first-value waiters with NO_VALUE on close", async () => {
        const entry = create();
        const waiting = entry.firstValue();

        entry.close();

        await expect(waiting).resolves.toBe(NO_VALUE);
    });
});
