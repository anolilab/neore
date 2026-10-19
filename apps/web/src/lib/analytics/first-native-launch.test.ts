import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNativeShell } from "@/lib/native/bridge";

import { reportFirstNativeLaunch } from "./first-native-launch";
import { trackEvent } from "./track";

vi.mock("./track", () => ({
    trackEvent: vi.fn(() => {
        return true;
    }),
}));
vi.mock("@/lib/native/bridge", () => ({
    isNativeShell: vi.fn(() => {
        return true;
    }),
}));

const KEY = "neore:desktop-first-launch";

beforeEach(() => {
    localStorage.clear();
    vi.mocked(isNativeShell).mockReturnValue(true);
    vi.mocked(trackEvent).mockReturnValue(true);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe(reportFirstNativeLaunch, () => {
    it("does nothing outside the desktop shell", () => {
        vi.mocked(isNativeShell).mockReturnValue(false);

        reportFirstNativeLaunch();

        expect(trackEvent).not.toHaveBeenCalled();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("sends once per profile, and sets the flag only after the event went out", () => {
        reportFirstNativeLaunch();
        reportFirstNativeLaunch();

        expect(trackEvent).toHaveBeenCalledTimes(1);
        expect(trackEvent).toHaveBeenCalledWith("desktop_first_launch", {});
        expect(localStorage.getItem(KEY)).toBe("1");
    });

    it("leaves the flag unset when PostHog is not loaded or the user opted out, so the next load tries again", () => {
        vi.mocked(trackEvent).mockReturnValueOnce(false);

        reportFirstNativeLaunch();
        expect(localStorage.getItem(KEY)).toBeNull();

        reportFirstNativeLaunch();
        expect(trackEvent).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem(KEY)).toBe("1");
    });
});
