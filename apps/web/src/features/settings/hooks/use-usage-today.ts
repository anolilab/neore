import { useEffect, useState } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";

import { dayKeyInZone } from "../lib/usage-activity";

/** How often an open view checks whether its day has turned. */
const DAY_CHECK_MS = 60_000;

/**
 * Today's `YYYY-MM-DD` in the zone usage rows are dated in — the user's time zone setting, else UTC — so a period's
 * first day lines up with the rows it reads, whatever the browser's own zone. `today` is `undefined` while the settings
 * load, and stays so when they fail (`failed`): a view then shows an error rather than a period dated in the wrong zone.
 * An open view moves to the next day within a minute of midnight in that zone. `zone` is that zone, for a view's
 * {@link keepAcrossDayTurn} scope: a changed zone is a new period, not a turned day.
 */
export const useUsageToday = (): { failed: boolean; today: string | undefined; zone: string } => {
    const { data: settings, isLoadingError } = useUserSettings();
    const zone = settings?.timezone;
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        // A zone that changes while a view is open is applied to the time now, not to when the day last turned.
        setNow(new Date());

        const check = (): void => {
            const next = new Date();

            // A new Date only on a new day, so the views keep their query until the period actually moves.
            setNow((current) => (dayKeyInZone(current, zone) === dayKeyInZone(next, zone) ? current : next));
        };
        // A tab left in the background past midnight catches up as soon as it is shown again, not at the next tick.
        const onVisible = (): void => {
            if (document.visibilityState === "visible") {
                check();
            }
        };
        const timer = setInterval(check, DAY_CHECK_MS);

        document.addEventListener("visibilitychange", onVisible);

        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [zone]);

    // Only a first load that failed is a failure: a failed refetch keeps the settings it had, and their zone.
    return { failed: isLoadingError, today: settings === undefined ? undefined : dayKeyInZone(now, zone), zone: zone || "UTC" };
};

/**
 * `options` that keep a view's last figures in sight while the day turns, so it never drops back to a skeleton at
 * midnight, but not when what it shows changes (`scope`: the selected period, or the project): those load afresh. The
 * options' own `meta` (such as `lunoraLive: false`, which keeps a read one-shot) is kept.
 */
export const keepAcrossDayTurn = <O extends { meta?: Record<string, unknown> }>(
    options: O,
    scope: string,
): O & {
    meta: Record<string, unknown>;
    placeholderData: <T>(previous: T | undefined, previousQuery: { meta?: Record<string, unknown> } | undefined) => T | undefined;
} => {
    return {
        ...options,
        meta: { ...options.meta, usageScope: scope },
        placeholderData: (previous, previousQuery) => (previousQuery?.meta?.usageScope === scope ? previous : undefined),
    };
};
