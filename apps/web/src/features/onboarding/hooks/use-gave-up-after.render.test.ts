// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGaveUpAfter } from "./use-gave-up-after";

describe(useGaveUpAfter, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("waits the given time, then gives up", () => {
        const { result } = renderHook(() => useGaveUpAfter(1500));

        act(() => vi.advanceTimersByTime(1499));

        expect(result.current).toBe(false);

        act(() => vi.advanceTimersByTime(1));

        expect(result.current).toBe(true);
    });

    it("leaves no timer behind once unmounted", () => {
        const { unmount } = renderHook(() => useGaveUpAfter(1500));

        unmount();

        expect(vi.getTimerCount()).toBe(0);
    });
});
