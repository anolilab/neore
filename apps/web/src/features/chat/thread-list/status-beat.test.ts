import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeStatusBeat as subscribe } from "./status-beat";

const root = document.documentElement;

const releasers: (() => void)[] = [];

const subscribeStatusBeat = (): (() => void) => {
    const release = subscribe();

    releasers.push(release);

    return release;
};

const env = { hidden: false, reduced: false };
const listeners = new Set<() => void>();

const media = {
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    get matches() {
        return env.reduced;
    },
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
};

describe("status beat clock", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env.reduced = false;
        env.hidden = false;
        listeners.clear();
        vi.stubGlobal("matchMedia", () => media);
        Object.defineProperty(document, "hidden", { configurable: true, get: () => env.hidden });
    });

    afterEach(() => {
        for (const release of releasers) {
            release();
        }

        releasers.length = 0;

        Reflect.deleteProperty(document, "hidden");
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("starts with the first subscriber, steps 0 1 2 0 and stops with the last", () => {
        const stop = subscribeStatusBeat();

        expect(root.dataset.statusBeat).toBe("0");
        vi.advanceTimersByTime(500);
        expect(root.dataset.statusBeat).toBe("1");
        vi.advanceTimersByTime(500);
        expect(root.dataset.statusBeat).toBe("2");
        vi.advanceTimersByTime(500);
        expect(root.dataset.statusBeat).toBe("0");

        stop();
        expect(root.dataset.statusBeat).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("alternates the tick on every step, also across the wrap from 2 to 0", () => {
        const stop = subscribeStatusBeat();
        const ticks: (string | undefined)[] = [root.dataset.statusTick];

        for (let step = 0; step < 4; step += 1) {
            vi.advanceTimersByTime(500);
            ticks.push(root.dataset.statusTick);
        }

        expect(ticks).toEqual(["0", "1", "0", "1", "0"]);
        stop();
        expect(root.dataset.statusTick).toBeUndefined();
    });

    it("runs one interval for many subscribers", () => {
        const stops = [subscribeStatusBeat(), subscribeStatusBeat(), subscribeStatusBeat()];

        expect(vi.getTimerCount()).toBe(1);
        stops[0]?.();
        stops[1]?.();
        expect(vi.getTimerCount()).toBe(1);
        stops[2]?.();
        expect(vi.getTimerCount()).toBe(0);
        expect(listeners.size).toBe(0);
    });

    it("ignores a second unsubscribe from the same subscriber", () => {
        const a = subscribeStatusBeat();
        const b = subscribeStatusBeat();

        a();
        a();
        expect(vi.getTimerCount()).toBe(1);
        b();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("never starts under reduced motion and reacts to the preference changing", () => {
        env.reduced = true;
        const stop = subscribeStatusBeat();

        expect(vi.getTimerCount()).toBe(0);
        expect(root.dataset.statusBeat).toBeUndefined();

        env.reduced = false;

        for (const listener of listeners) {
            listener();
        }

        expect(vi.getTimerCount()).toBe(1);
        stop();
    });

    it("pauses while the document is hidden and resumes when visible", () => {
        const stop = subscribeStatusBeat();

        env.hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(vi.getTimerCount()).toBe(0);
        expect(root.dataset.statusBeat).toBeUndefined();

        env.hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(vi.getTimerCount()).toBe(1);
        stop();
    });
});
