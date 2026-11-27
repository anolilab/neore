"use client";

import { useLingui } from "@lingui/react/macro";
import { Switch } from "@neore/ui/components/switch";
import { CalendarClockIcon } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

interface ScheduleIdeasSwitchProps {
    memoryEnabled: boolean;
}

/**
 * Turns the daily suggestions of scheduled tasks on or off. OPT-IN: absent means off, matching the backend's
 * `readScheduleIdeasEnabled`. The job also needs memory on, so the switch is disabled while memory is off, like the
 * other memory controls, and until the settings have loaded.
 *
 * The saved value is the `checked` the switch reports, never the opposite of what this render shows: two taps before a
 * re-render would both send the same value. The write goes through the settings queue, so quick taps land in order.
 */
const ScheduleIdeasSwitch: FC<ScheduleIdeasSwitchProps> = ({ memoryEnabled }) => {
    const { t } = useLingui();
    const { data: userSettings } = useUserSettings();
    const { updateLatest } = useUpdateUserSettings();
    const enabled = userSettings?.scheduleIdeasEnabled === true;
    const disabled = userSettings === undefined || !memoryEnabled;

    const save = (checked: boolean) => {
        updateLatest(() => {
            return { scheduleIdeasEnabled: checked };
        })
            .then(() => {
                toast.success(checked ? t`Schedule ideas enabled` : t`Schedule ideas disabled`);

                return undefined;
            })
            .catch(() => {
                toast.error(t`Failed to update setting`);
            });
    };

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm font-medium" htmlFor="schedule-ideas-switch">
                    <CalendarClockIcon aria-hidden="true" className="text-muted-foreground h-4 w-4" />
                    {t`Suggest scheduled tasks`}
                </label>
                <Switch aria-describedby="schedule-ideas-description" checked={enabled} disabled={disabled} id="schedule-ideas-switch" onCheckedChange={save} />
            </div>
            <p className="text-muted-foreground text-xs" id="schedule-ideas-description">
                {t`Once a day, suggest recurring tasks based only on your own recent messages. Nothing is created until you accept a suggestion. Turning this off deletes the suggestions waiting for you.`}
                {!memoryEnabled && <> {t`No ideas are made while memory is off.`}</>}
            </p>
        </div>
    );
};

export default ScheduleIdeasSwitch;
