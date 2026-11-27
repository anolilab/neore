import { describe, expect, it, vi } from "vitest";

import { drainMicrotasks } from "@/lib/drain-microtasks";

import type { BrowserStatus } from "./browser-api";
import { watchBrowserLink } from "./browser-link-watch";
import { GRANT_END_MARGIN_MS } from "./browser-view-state";

const running = (fields: Partial<Extract<BrowserStatus, { kind: "running" }>> = {}): BrowserStatus => {
    return { browserId: "b-1", canControl: false, currentUrl: "https://example.com", idleUntil: 1_000_000, kind: "running", now: 0, ...fields };
};

/** A clock and timers the test moves by hand. */
const timers = () => {
    const clock = { at: 0 };
    let pending: { at: number; run: () => void }[] = [];

    return {
        advanceTo: (at: number) => {
            clock.at = at;

            const due = pending.filter((entry) => entry.at <= at);

            pending = pending.filter((entry) => entry.at > at);

            for (const entry of due) {
                entry.run();
            }
        },
        after: (ms: number, run: () => void) => {
            const entry = { at: clock.at + ms, run };

            pending.push(entry);

            return () => {
                pending = pending.filter((other) => other !== entry);
            };
        },
        now: () => clock.at,
    };
};

describe(watchBrowserLink, () => {
    it("hides a reader's link at the grant's end, and shows it again when the read at the real end finds it renewed", async () => {
        const { advanceTo, after, now } = timers();
        const shown: boolean[] = [];
        const read = vi.fn(async () => running({ accessUntil: 120_000, now: 60_000 }));
        const link = watchBrowserLink({
            after,
            now,
            onChange: (isShown) => {
                shown.push(isShown);
            },
            read,
        });

        link.show(running({ accessUntil: 60_000, now: 0 }));
        expect(shown).toStrictEqual([true]);

        // Hidden a little before the grant's end, with no new status.
        advanceTo(60_000 - GRANT_END_MARGIN_MS);
        expect(shown).toStrictEqual([true, false]);
        expect(read).not.toHaveBeenCalled();

        // At the real end the status is read once: the grant was renewed, so the link comes back.
        advanceTo(60_000);
        expect(read).toHaveBeenCalledTimes(1);
        await drainMicrotasks();
        expect(shown).toStrictEqual([true, false, true]);
    });

    it("hides the owner's link when the browser goes idle with no new status, and shows it again if it was kept alive", async () => {
        const { advanceTo, after, now } = timers();
        const shown: boolean[] = [];
        const read = vi.fn(async () => running({ idleUntil: 200_000, now: 100_000 }));
        const link = watchBrowserLink({
            after,
            now,
            onChange: (isShown) => {
                shown.push(isShown);
            },
            read,
        });

        link.show(running({ idleUntil: 100_000, now: 0 }));
        advanceTo(100_000);
        expect(shown).toStrictEqual([true, false]);

        advanceTo(100_000 + GRANT_END_MARGIN_MS);
        expect(read).toHaveBeenCalledTimes(1);
        await drainMicrotasks();
        expect(shown).toStrictEqual([true, false, true]);
    });

    it("keeps the owner's link while the browser runs, and drops it for a stopped browser or a failed query", () => {
        const { after, now } = timers();
        const shown: boolean[] = [];
        const link = watchBrowserLink({
            after,
            now,
            onChange: (isShown) => {
                shown.push(isShown);
            },
            read: vi.fn(),
        });

        link.show(running());
        link.show({ kind: "none", now: 0 } as BrowserStatus);
        link.show(running());
        link.show(undefined);

        expect(shown).toStrictEqual([true, false, true, false]);
    });

    it("lets a newer status replace the timers of the one before, and stops them all", () => {
        const { advanceTo, after, now } = timers();
        const shown: boolean[] = [];
        const read = vi.fn(async () => running());
        const link = watchBrowserLink({
            after,
            now,
            onChange: (isShown) => {
                shown.push(isShown);
            },
            read,
        });

        link.show(running({ accessUntil: 10_000, now: 0 }));
        link.show(running());
        advanceTo(20_000);
        expect(shown).toStrictEqual([true, true]);
        expect(read).not.toHaveBeenCalled();

        link.show(running({ accessUntil: 30_000, now: 20_000 }));
        link.stop();
        advanceTo(40_000);
        expect(read).not.toHaveBeenCalled();
    });

    it("never lets a read at the grant's end that answers after a newer live status undo it", async () => {
        const { advanceTo, after, now } = timers();
        const shown: boolean[] = [];
        const late = Promise.withResolvers<BrowserStatus>();
        const link = watchBrowserLink({
            after,
            now,
            onChange: (isShown) => {
                shown.push(isShown);
            },
            read: async () => await late.promise,
        });

        link.show(running({ accessUntil: 60_000, now: 0 }));
        advanceTo(60_000);
        // The read is out when the browser closes: the live status hides the link.
        link.show({ kind: "none", now: 60_000 } as BrowserStatus);
        late.resolve(running({ accessUntil: 120_000, now: 60_000 }));
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(shown).toStrictEqual([true, false, false]);
    });
});
