import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useCRPC } from "@/lib/lunora/crpc";

import type { SetupStepId } from "../lib/setup-steps";
import { deriveSetupSteps, detectSetupDone, SETUP_STEP_IDS, toggleSkipped } from "../lib/setup-steps";

/** How often the device list is read again while no computer is paired. */
const PAIRING_POLL_MS = 5000;

/** Where each step's action goes: the control on this page, or the guide for the part that happens in the desktop app. */
const STEP_TARGET: Record<SetupStepId, string> = {
    agent: "/docs/devices#coding-agents-on-a-computer",
    pair: "#devices-pairing",
    ssh: "#devices-ssh",
};

type SkippedRow = { setupStepsSkipped?: string[] } | null | undefined;

/**
 * First-run setup. The web only explains and links: pairing and agent installs happen in the desktop app's own
 * window, so nothing here makes the desktop do anything.
 */
const SetupChecklist: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const settingsQuery = useUserSettings();
    const settingsKey = crpc.auth.functions.getUserSettings.queryOptions({}).queryKey;
    // The step whose last save was refused: the message stays beside it after the toast has gone.
    const [failedStep, setFailedStep] = useState<SetupStepId | undefined>(undefined);
    // Pairing happens in the desktop app, outside this page: while the step is open the list is read again on focus and
    // every few seconds, then left alone.
    const pairingOpen = (devices: Parameters<typeof detectSetupDone>[0]) =>
        !detectSetupDone(devices).pair && settingsQuery.data?.setupStepsSkipped?.includes("pair") !== true;
    const devicesQuery = useQuery({
        ...crpc.devices.functions.listDevices.queryOptions({}),
        refetchInterval: (query) => (pairingOpen(query.state.data) ? PAIRING_POLL_MS : false),
        refetchOnWindowFocus: (query) => (pairingOpen(query.state.data) ? "always" : false),
    });
    // One step per call: the server applies it to the list it holds, so another tab's skip is never overwritten.
    const setSkipped = useMutation({
        ...crpc.auth.setup_steps.setSetupStepSkipped.mutationOptions(),
        // Saves run in click order, so a Skip still on its way can never land after the Resume that followed it.
        scope: { id: "setup-steps-skip" },
        onError: (_error, args) => {
            // Undo only this step; the server's push carries whatever is stored.
            queryClient.setQueryData<SkippedRow>(settingsKey, (row) =>
                row ? { ...row, setupStepsSkipped: toggleSkipped(row.setupStepsSkipped, args.stepId, !args.skipped) } : row,
            );
            setFailedStep(args.stepId);
            toast.error(t`Could not save that choice. Try again.`);
        },
        onMutate: async (args) => {
            setFailedStep(undefined);
            // A read still in flight would land after the patch with the value from before the click.
            await queryClient.cancelQueries({ queryKey: settingsKey });
            queryClient.setQueryData<SkippedRow>(settingsKey, (row) =>
                row ? { ...row, setupStepsSkipped: toggleSkipped(row.setupStepsSkipped, args.stepId, args.skipped) } : row,
            );
        },
    });
    // An account with no settings row answers `null`; only `undefined` means the read has not finished. Until both reads
    // have answered, no step has a status: a skip that is stored but not yet read must not show as "To do".
    const steps =
        settingsQuery.data !== undefined && devicesQuery.isSuccess ? deriveSetupSteps(devicesQuery.data, settingsQuery.data?.setupStepsSkipped) : undefined;

    const copy: Record<SetupStepId, { action: string; description: string; title: string }> = {
        agent: {
            action: t`Read the guide`,
            description: t`Install a coding agent in the Neore desktop app and approve it for a folder on a paired computer. The install happens in the desktop window, not here.`,
            title: t`Install a coding agent`,
        },
        pair: {
            action: t`Go to pairing`,
            description: t`Pair a computer in the Neore desktop app so agents can work on your files. You confirm the pairing on that computer, and the step is done once any computer is paired with your account.`,
            title: t`Pair a computer`,
        },
        ssh: {
            action: t`Go to servers`,
            description: t`Let the agent work on a server you reach over SSH. Needs a paired computer.`,
            title: t`Add an SSH server`,
        },
    };
    const statusLabel = { done: t`Done`, skipped: t`Skipped`, todo: t`To do` };
    const pendingLabel = devicesQuery.isError || settingsQuery.isError ? t`Could not check` : t`Checking`;

    return (
        <SettingsCard description={t`Three steps to use coding agents on your own machines. Skip any of them and come back later.`} title={t`Coding setup`}>
            <CardContent>
                <ol aria-label={t`Coding setup steps`} aria-live="polite" className="space-y-3">
                    {(steps ?? SETUP_STEP_IDS.map((id) => ({ id, status: undefined }))).map(({ id, status }) => (
                        <li className="flex flex-wrap items-center gap-3" key={id}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">
                                    {status === "done" && <Check aria-hidden="true" className="mr-1 inline size-4" />}
                                    {copy[id].title} <span className="text-muted-foreground font-normal">({status ? statusLabel[status] : pendingLabel})</span>
                                </p>
                                <p className="text-muted-foreground text-xs">{copy[id].description}</p>
                                {failedStep === id && (
                                    <p className="text-destructive mt-1 text-xs" role="alert">
                                        {t`Could not save that choice. Try again.`}
                                    </p>
                                )}
                            </div>
                            {/* The links stay while the device check is pending or failed; only Skip and Resume need a known status. */}
                            {status !== "done" && (
                                <>
                                    <a className={buttonVariants({ size: "sm", variant: "outline" })} href={STEP_TARGET[id]}>
                                        {copy[id].action}
                                        <span className="sr-only">: {copy[id].title}</span>
                                    </a>
                                    {status !== undefined && (
                                        <Button
                                            disabled={settingsQuery.isError}
                                            onClick={() => {
                                                setSkipped.mutate({ skipped: status === "todo", stepId: id });
                                            }}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            {status === "todo" ? t`Skip` : t`Resume`}
                                            <span className="sr-only">: {copy[id].title}</span>
                                        </Button>
                                    )}
                                </>
                            )}
                        </li>
                    ))}
                </ol>
                {devicesQuery.isError && (
                    <div className="mt-3 flex flex-wrap items-center gap-3" role="alert">
                        <p className="text-destructive text-xs">{t`Could not read your devices, so the steps cannot be checked yet. The links still work.`}</p>
                        <Button
                            onClick={() => {
                                devicesQuery.refetch().catch(() => {});
                            }}
                            size="sm"
                            variant="outline"
                        >
                            {t`Retry the device check`}
                        </Button>
                    </div>
                )}
                {settingsQuery.isError && (
                    <div className="mt-3 flex flex-wrap items-center gap-3" role="alert">
                        <p className="text-destructive text-xs">{t`Could not load your saved choices, so Skip and Resume are off until it is read again.`}</p>
                        <Button
                            onClick={() => {
                                settingsQuery.refetch().catch(() => {});
                            }}
                            size="sm"
                            variant="outline"
                        >
                            {t`Retry`}
                        </Button>
                    </div>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default SetupChecklist;
