import { describe, expect, it } from "vitest";

import type { SleepBlocker } from "./keep-awake";
import { SleepLock } from "./keep-awake";

/** A blocker that records what it holds; `failStart` makes every start throw, as a platform without a power service would. */
const fakeBlocker = (options: { failStart?: boolean } = {}) => {
    const live = new Set<number>();
    const blocker: SleepBlocker & { starts: number } = {
        isStarted: (id) => live.has(id),
        start: () => {
            if (options.failStart === true) {
                throw new Error("no power service");
            }

            blocker.starts += 1;

            const id = blocker.starts;

            live.add(id);

            return id;
        },
        starts: 0,
        stop: (id) => {
            live.delete(id);
        },
    };

    return { blocker, live };
};

describe("the sleep lock", () => {
    it("holds one inhibitor while any source runs a turn, and releases it when the last one stops", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);
        const local = {};
        const server = {};

        lock.report(local, true);
        lock.report(server, true);

        expect(live.size).toBe(1);
        expect(blocker.starts).toBe(1);

        lock.report(local, false);

        expect(live.size).toBe(1);

        lock.report(server, false);

        expect(live.size).toBe(0);
    });

    it("does nothing for a report that repeats the state it already has", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);
        const source = {};

        lock.report(source, true);
        lock.report(source, true);

        expect(blocker.starts).toBe(1);

        lock.report(source, false);
        lock.report(source, false);

        expect(live.size).toBe(0);
        expect(blocker.starts).toBe(1);
    });

    it("forgets every source and releases the inhibitor on release, so a later turn holds a new one", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);

        lock.report({}, true);
        lock.report({}, true);
        lock.release();

        expect(live.size).toBe(0);

        lock.report({}, true);

        expect(live.size).toBe(1);
        expect(blocker.starts).toBe(2);
    });

    it("takes a new inhibitor when the platform dropped the one it held while a turn still runs", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);
        const source = {};

        lock.report(source, true);
        live.clear();
        lock.report(source, true);

        expect(live.size).toBe(1);
        expect(blocker.starts).toBe(2);
    });

    it("logs a blocker that cannot start and never throws into the turn", () => {
        const { blocker } = fakeBlocker({ failStart: true });
        const messages: string[] = [];
        const lock = new SleepLock(blocker, (message) => {
            messages.push(message);
        });

        expect(() => {
            lock.report({}, true);
        }).not.toThrow();
        expect(messages).toEqual(["[keep-awake] could not hold the sleep lock: no power service"]);
    });
});
