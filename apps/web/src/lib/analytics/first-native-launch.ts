import { isNativeShell } from "@/lib/native/bridge";

import { trackEvent } from "./track";

const REPORTED_KEY = "neore:desktop-first-launch";

/**
 * Reports `desktop_first_launch` once per desktop profile. The flag is set only
 * when `trackEvent` actually sent the event, so a load where PostHog is not
 * loaded or the user has opted out leaves it unset, and the next load tries again.
 */
export const reportFirstNativeLaunch = (): void => {
    if (!isNativeShell()) {
        return;
    }

    try {
        if (localStorage.getItem(REPORTED_KEY) !== null) {
            return;
        }

        if (trackEvent("desktop_first_launch", {})) {
            localStorage.setItem(REPORTED_KEY, "1");
        }
    } catch {
        // Storage is blocked: report nothing rather than on every load.
    }
};
