import { describe, expect, it, vi } from "vitest";

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

    it("takes a new inhibitor at the next change of state when the platform dropped the one it held", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);
        const source = {};

        lock.report(source, true);
        live.clear();
        lock.report(source, false);
        lock.report(source, true);

        expect(live.size).toBe(1);
        expect(blocker.starts).toBe(2);
    });

    it("keeps the inhibitor id when stop throws, so the next release retries the stop", () => {
        const live = new Set<number>();
        let starts = 0;
        let stopFailures = 1;
        const lock = new SleepLock(
            {
                isStarted: (id) => live.has(id),
                start: () => {
                    starts += 1;
                    live.add(starts);

                    return starts;
                },
                stop: (id) => {
                    if (stopFailures > 0) {
                        stopFailures -= 1;

                        throw new Error("busy");
                    }

                    live.delete(id);
                },
            },
            () => undefined,
        );
        const source = {};

        lock.report(source, true);
        lock.report(source, false);

        expect(live.size).toBe(1);

        lock.report(source, true);

        expect(starts).toBe(1);

        lock.report(source, false);

        expect(live.size).toBe(0);
    });

    it("retries a stop that failed at the end of the last turn on its own, once the pause is over", () => {
        vi.useFakeTimers();

        try {
            const live = new Set<number>();
            let starts = 0;
            let stopFailures = 1;
            const lock = new SleepLock(
                {
                    isStarted: (id) => live.has(id),
                    start: () => {
                        starts += 1;
                        live.add(starts);

                        return starts;
                    },
                    stop: (id) => {
                        if (stopFailures > 0) {
                            stopFailures -= 1;

                            throw new Error("busy");
                        }

                        live.delete(id);
                    },
                },
                () => undefined,
                5000,
            );
            const source = {};

            lock.report(source, true);
            lock.report(source, false);

            expect(live.size).toBe(1);

            vi.advanceTimersByTime(5000);

            expect(live.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not ask the platform during the pause after a failed start, and asks again once it is over", () => {
        vi.useFakeTimers();

        try {
            const live = new Set<number>();
            let attempts = 0;
            const lock = new SleepLock(
                {
                    isStarted: (id) => live.has(id),
                    start: () => {
                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error("no power service");
                        }

                        live.add(attempts);

                        return attempts;
                    },
                    stop: (id) => {
                        live.delete(id);
                    },
                },
                () => undefined,
                5000,
            );
            const source = {};

            lock.report(source, true);

            expect(attempts).toBe(1);

            // An output update during the pause changes nothing and asks nobody.
            lock.report(source, true);

            expect(attempts).toBe(1);

            vi.advanceTimersByTime(5000);

            expect(attempts).toBe(2);
            expect(live.size).toBe(1);
        } finally {
            vi.useRealTimers();
        }
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

    it("takes back an inhibitor the platform dropped, on the next report from a running source", () => {
        const { blocker, live } = fakeBlocker();
        const lock = new SleepLock(blocker);
        const source = {};

        lock.report(source, true);
        live.clear();
        lock.report(source, true);

        expect(live.size).toBe(1);
        expect(blocker.starts).toBe(2);
    });

    it("checks the inhibitor on output updates at most once per interval, not on every update", () => {
        vi.useFakeTimers();

        try {
            const live = new Set<number>();
            let checks = 0;
            let starts = 0;
            const lock = new SleepLock(
                {
                    isStarted: (id) => {
                        checks += 1;

                        return live.has(id);
                    },
                    start: () => {
                        starts += 1;
                        live.add(starts);

                        return starts;
                    },
                    stop: (id) => {
                        live.delete(id);
                    },
                },
                () => undefined,
                5000,
            );
            const source = {};

            lock.report(source, true);

            const afterStart = checks;

            for (let update = 0; update < 10; update += 1) {
                lock.report(source, true);
            }

            expect(checks - afterStart).toBe(1);

            vi.advanceTimersByTime(5000);
            lock.report(source, true);

            expect(checks - afterStart).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not ask the platform again for sources that start during the pause after a failed start", () => {
        vi.useFakeTimers();

        try {
            const live = new Set<number>();
            let attempts = 0;
            const lock = new SleepLock(
                {
                    isStarted: (id) => live.has(id),
                    start: () => {
                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error("no power service");
                        }

                        live.add(attempts);

                        return attempts;
                    },
                    stop: (id) => {
                        live.delete(id);
                    },
                },
                () => undefined,
                5000,
            );

            lock.report({}, true);

            expect(attempts).toBe(1);

            // Two more managers start a turn during the pause: neither asks the platform.
            lock.report({}, true);
            lock.report({}, true);

            expect(attempts).toBe(1);

            vi.advanceTimersByTime(5000);

            expect(attempts).toBe(2);
            expect(live.size).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
