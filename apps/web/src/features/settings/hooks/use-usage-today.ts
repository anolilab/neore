import { useUserSettings } from "@/features/auth/hooks/use-user-settings";

import { dayKeyInZone } from "../lib/usage-activity";

/**
 * Today's `YYYY-MM-DD` in the zone usage rows are dated in — the user's time zone setting, else UTC — so a period's
 * first day lines up with the rows it reads, whatever the browser's own zone.
 */
export const useUsageToday = (): string => {
    const { data: settings } = useUserSettings();

    return dayKeyInZone(new Date(), settings?.timezone);
};
