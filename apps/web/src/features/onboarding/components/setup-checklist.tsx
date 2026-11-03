import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { FC } from "react";

import SettingsCard from "@/components/settings/settings-card";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useCRPC } from "@/lib/lunora/crpc";

import type { SetupStepId } from "../lib/setup-steps";
import { deriveSetupSteps, toggleSkipped } from "../lib/setup-steps";

const DEVICES_PATH = "/dashboard/settings/chat/devices";

/**
 * First-run setup. The web only explains and links: pairing and agent installs happen in the desktop app's own
 * window, so nothing here makes the desktop do anything.
 */
const SetupChecklist: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: devices } = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const { data: settings } = useUserSettings();
    const { updateLatest } = useUpdateUserSettings();
    const steps = deriveSetupSteps(devices, settings?.setupStepsSkipped);

    const copy: Record<SetupStepId, { action: string; description: string; title: string }> = {
        agent: {
            action: t`Open devices`,
            description: t`Install a coding agent in the Neore desktop app and approve it for a folder on a paired computer. The install happens in the desktop window, not here.`,
            title: t`Install a coding agent`,
        },
        pair: {
            action: t`Open devices`,
            description: t`Pair this computer in the Neore desktop app so agents can work on your files. You confirm the pairing on that computer.`,
            title: t`Pair this computer`,
        },
        ssh: {
            action: t`Open devices`,
            description: t`Let the agent work on a server you reach over SSH. Needs a paired computer.`,
            title: t`Add an SSH server`,
        },
    };
    const statusLabel = { done: t`Done`, skipped: t`Skipped`, todo: t`To do` };

    return (
        <SettingsCard description={t`Three steps to use coding agents on your own machines. Skip any of them and come back later.`} title={t`Coding setup`}>
            <CardContent>
                <ol aria-label={t`Coding setup steps`} className="space-y-3">
                    {steps.map(({ id, status }) => (
                        <li className="flex flex-wrap items-center gap-3" key={id}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">
                                    {status === "done" && <Check aria-hidden="true" className="mr-1 inline size-4" />}
                                    {copy[id].title} <span className="text-muted-foreground font-normal">({statusLabel[status]})</span>
                                </p>
                                <p className="text-muted-foreground text-xs">{copy[id].description}</p>
                            </div>
                            {status !== "done" && (
                                <>
                                    <Button nativeButton={false} render={<a href={DEVICES_PATH} />} size="sm" variant="outline">
                                        {copy[id].action}
                                        <span className="sr-only">: {copy[id].title}</span>
                                    </Button>
                                    <Button
                                        onClick={() => {
                                            updateLatest((current) => {
                                                return { setupStepsSkipped: toggleSkipped(current?.setupStepsSkipped, id, status === "todo") };
                                            }).catch(() => {});
                                        }}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        {status === "todo" ? t`Skip` : t`Resume`}
                                        <span className="sr-only">: {copy[id].title}</span>
                                    </Button>
                                </>
                            )}
                        </li>
                    ))}
                </ol>
            </CardContent>
        </SettingsCard>
    );
};

export default SetupChecklist;
