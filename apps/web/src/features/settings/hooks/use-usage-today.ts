import { useUserSettings } from "@/features/auth/hooks/use-user-settings";

import { dayKeyInZone } from "../lib/usage-activity";

/**
 * Today's `YYYY-MM-DD` in the zone usage rows are dated in — the user's time zone setting, else UTC — so a period's
 * first day lines up with the rows it reads, whatever the browser's own zone. `undefined` while the settings load, so a
 * view waits for the right day instead of reading a UTC one first.
 */
export const useUsageToday = (): string | undefined => {
    const { data: settings, isPending } = useUserSettings();

    return isPending ? undefined : dayKeyInZone(new Date(), settings?.timezone);
};
