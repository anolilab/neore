import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keepAcrossDayTurn, useUsageToday } from "./use-usage-today";

const { settings } = vi.hoisted(() => {
    return { settings: { data: { timezone: "Europe/Berlin" } as { timezone?: string } | undefined, isError: false, isLoadingError: false } };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return { useUserSettings: () => settings };
});

describe("useUsageToday", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        settings.data = { timezone: "Europe/Berlin" };
        settings.isError = false;
        settings.isLoadingError = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("dates the day in the user's zone and moves to the next day at midnight there while the view stays open", () => {
        // 21:58 UTC is 23:58 in Berlin (summer time) on 30 September.
        vi.setSystemTime(new Date("2026-09-30T21:58:00Z"));

        const { result } = renderHook(() => useUsageToday());

        expect(result.current).toStrictEqual({ failed: false, today: "2026-09-30", zone: "Europe/Berlin" });

        act(() => {
            vi.advanceTimersByTime(3 * 60_000);
        });

        expect(result.current.today).toBe("2026-10-01");
    });

    it("gives no day while the settings load, and fails rather than dating in UTC when they cannot be read", () => {
        settings.data = undefined;

        const { rerender, result } = renderHook(() => useUsageToday());

        expect(result.current).toStrictEqual({ failed: false, today: undefined, zone: "UTC" });

        settings.isLoadingError = true;
        rerender();

        expect(result.current).toStrictEqual({ failed: true, today: undefined, zone: "UTC" });
    });

    it("keeps the day when a later settings read fails but the settings it had remain", () => {
        vi.setSystemTime(new Date("2026-09-30T21:58:00Z"));

        // A failed refetch: an error status, but the earlier data is still there.
        settings.isError = true;

        const { result } = renderHook(() => useUsageToday());

        expect(result.current).toStrictEqual({ failed: false, today: "2026-09-30", zone: "Europe/Berlin" });
    });
});

describe("keepAcrossDayTurn", () => {
    it("keeps the last figures while the day turns, and drops them when the period or project changes", () => {
        const { placeholderData } = keepAcrossDayTurn({}, "projects:30");

        expect(placeholderData("figures", { meta: { usageScope: "projects:30" } })).toBe("figures");
        expect(placeholderData("figures", { meta: { usageScope: "projects:7" } })).toBeUndefined();
        expect(placeholderData("figures", undefined)).toBeUndefined();
        // A changed time zone is a new period, not a turned day: its scope differs, so the figures go too.
        expect(keepAcrossDayTurn({}, "projects:Europe/Berlin:30").placeholderData("figures", { meta: { usageScope: "projects:UTC:30" } })).toBeUndefined();
    });

    it("keeps the options' own meta, so a one-shot read stays one-shot", () => {
        const options = keepAcrossDayTurn({ meta: { lunoraLive: false }, queryKey: ["usage"] }, "skills:7");

        expect(options.meta).toStrictEqual({ lunoraLive: false, usageScope: "skills:7" });
        expect(options.queryKey).toStrictEqual(["usage"]);
    });
});
