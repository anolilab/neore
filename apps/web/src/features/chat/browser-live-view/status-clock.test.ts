// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePassed, useStatusSkew } from "./status-clock";

/** The longest delay a browser timer keeps; `usePassed` waits in steps of it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const START = Date.UTC(2026, 10, 21, 12, 0, 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
});

afterEach(() => {
    vi.useRealTimers();
});

const advance = (ms: number): void => {
    act(() => {
        vi.advanceTimersByTime(ms);
    });
};

describe("usePassed", () => {
    it("turns true once the deadline passes, with no new answer, and leaves no timer behind on unmount", () => {
        const { result, unmount } = renderHook(() => usePassed(START + 10_000));

        expect(result.current).toBe(false);
        advance(9999);
        expect(result.current).toBe(false);
        advance(100);
        expect(result.current).toBe(true);

        const view = renderHook(() => usePassed(START + 60_000));

        view.unmount();
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits out a deadline past the longest timer delay in steps, never arming a longer timer, which would fire at once", () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const until = START + MAX_TIMER_DELAY_MS + 60_000;
        const { result } = renderHook(() => usePassed(until));

        // The first step is the longest delay a timer keeps; at its end the timer re-arms for what is left.
        advance(MAX_TIMER_DELAY_MS);
        expect(result.current).toBe(false);

        advance(59_000);
        expect(result.current).toBe(false);
        advance(1100);
        expect(result.current).toBe(true);

        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay ?? 0);

        expect(delays[0]).toBe(MAX_TIMER_DELAY_MS);
        expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
        // Two steps, not a timer firing over and over.
        expect(delays).toHaveLength(2);
    });
});

describe("useStatusSkew", () => {
    it("keeps a deadline anchored to when its answer came: a refetch of the same answer moves nothing later", () => {
        // The server's clock is 5 s ahead; the answer took 200 ms to get here.
        const serverNow = START + 5000;
        const { rerender, result } = renderHook(({ at, now }: { at: number; now: number | undefined }) => useStatusSkew(now, at), {
            initialProps: { at: START + 200, now: serverNow as number | undefined },
        });

        expect(result.current).toBe(4800);

        // A live query hands back the same push later: the skew, and every deadline taken from it, stays.
        rerender({ at: START + 30_000, now: serverNow });
        expect(result.current).toBe(4800);

        // A new answer (its own server time) is anchored to when it came.
        rerender({ at: START + 31_000, now: START + 36_500 });
        expect(result.current).toBe(5500);
    });

    it("is no skew with no answer yet", () => {
        const { result } = renderHook(() => useStatusSkew(undefined, START));

        expect(result.current).toBe(0);
    });
});
