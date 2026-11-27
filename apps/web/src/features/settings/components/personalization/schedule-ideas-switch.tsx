"use client";

import { useLingui } from "@lingui/react/macro";
import { Switch } from "@neore/ui/components/switch";
import type { FC } from "react";
import { toast } from "sonner";

import SettingsRow from "@/components/settings/settings-row";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

interface ScheduleIdeasSwitchProps {
    memoryEnabled: boolean;
}

/**
 * Turns the daily suggestions of scheduled tasks on or off. OPT-IN: absent means off, matching the backend's
 * `readScheduleIdeasEnabled`. The job also needs memory on, so with memory off the switch cannot be turned ON; it can
 * still be turned OFF, which erases the suggestions waiting (the backend erases them when memory goes off too, but a
 * switch left on must stay a way out). It is disabled until the settings have loaded.
 *
 * The saved value is the `checked` the switch reports, sent as it is and never rebuilt from the settings cache at a
 * queue's turn (`updateLatest`): a quick off then on would reach the server as two `true` writes, and the erase, which
 * runs on a save of `false`, would never run. The writes still leave one at a time, in tap order (`updateExact`), so the
 * last one to arrive is the last tap.
 */
const ScheduleIdeasSwitch: FC<ScheduleIdeasSwitchProps> = ({ memoryEnabled }) => {
    const { t } = useLingui();
    const { data: userSettings } = useUserSettings();
    const { updateExact } = useUpdateUserSettings();
    const enabled = userSettings?.scheduleIdeasEnabled === true;
    const disabled = userSettings === undefined || (!memoryEnabled && !enabled);

    const save = (checked: boolean) => {
        updateExact({ scheduleIdeasEnabled: checked })
            .then(() => {
                toast.success(checked ? t`Schedule ideas enabled` : t`Schedule ideas disabled`);

                return undefined;
            })
            .catch(() => {
                toast.error(t`Failed to update setting`);
            });
    };

    return (
        <SettingsRow
            control={
                <Switch aria-describedby="schedule-ideas-description" checked={enabled} disabled={disabled} id="schedule-ideas-switch" onCheckedChange={save} />
            }
            description={
                <>
                    {t`Once a day, suggest recurring tasks based only on your own recent messages. Nothing is created until you accept a suggestion. Turning this off deletes the suggestions waiting for you.`}
                    {!memoryEnabled && <> {t`No ideas are made while memory is off.`}</>}
                </>
            }
            descriptionId="schedule-ideas-description"
            htmlFor="schedule-ideas-switch"
            title={t`Suggest scheduled tasks`}
        />
    );
};

export default ScheduleIdeasSwitch;
