import { useEffect, useState } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";

import { dayKeyInZone } from "../lib/usage-activity";

/** How often an open view checks whether its day has turned. */
const DAY_CHECK_MS = 60_000;

/**
 * Today's `YYYY-MM-DD` in the zone usage rows are dated in — the user's time zone setting, else UTC — so a period's
 * first day lines up with the rows it reads, whatever the browser's own zone. `today` is `undefined` while the settings
 * load, and stays so when they fail (`failed`): a view then shows an error rather than a period dated in the wrong zone.
 * An open view moves to the next day within a minute of midnight in that zone.
 */
export const useUsageToday = (): { failed: boolean; today: string | undefined } => {
    const { data: settings, isLoadingError } = useUserSettings();
    const zone = settings?.timezone;
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const timer = setInterval(() => {
            const next = new Date();

            // A new Date only on a new day, so the views keep their query until the period actually moves.
            setNow((current) => (dayKeyInZone(current, zone) === dayKeyInZone(next, zone) ? current : next));
        }, DAY_CHECK_MS);

        return () => clearInterval(timer);
    }, [zone]);

    // Only a first load that failed is a failure: a failed refetch keeps the settings it had, and their zone.
    return { failed: isLoadingError, today: settings === undefined ? undefined : dayKeyInZone(now, zone) };
};
