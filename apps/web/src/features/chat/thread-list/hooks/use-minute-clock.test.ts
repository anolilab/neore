import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import useMinuteClock from "./use-minute-clock";

const MINUTE = 60_000;

describe(useMinuteClock, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("rounds down to the minute and moves on at the next minute boundary, not a minute after mounting", () => {
        vi.setSystemTime(new Date("2026-11-05T12:00:59.000Z"));

        const { result, unmount } = renderHook(() => useMinuteClock());

        expect(result.current).toBe(Date.parse("2026-11-05T12:00:00.000Z"));

        act(() => {
            vi.advanceTimersByTime(1000);
        });

        expect(result.current).toBe(Date.parse("2026-11-05T12:01:00.000Z"));

        act(() => {
            vi.advanceTimersByTime(MINUTE);
        });

        expect(result.current).toBe(Date.parse("2026-11-05T12:02:00.000Z"));

        unmount();
    });

    it("shares one timer between rows and stops it when the last row unmounts", () => {
        vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));

        const { unmount: unmountFirst } = renderHook(() => useMinuteClock());
        const { unmount: unmountSecond } = renderHook(() => useMinuteClock());

        expect(vi.getTimerCount()).toBe(1);

        unmountFirst();

        expect(vi.getTimerCount()).toBe(1);

        unmountSecond();

        expect(vi.getTimerCount()).toBe(0);
    });

    it("catches up on the minutes missed while nothing was mounted", () => {
        vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
        renderHook(() => useMinuteClock()).unmount();

        vi.setSystemTime(new Date("2026-11-05T12:07:30.000Z"));

        const { result, unmount } = renderHook(() => useMinuteClock());

        expect(result.current).toBe(Date.parse("2026-11-05T12:07:00.000Z"));

        unmount();
    });
});
