import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import type { SetupStepId, SkipVariables } from "../lib/setup-steps";
import { deriveSetupSteps, SETUP_STEP_IDS, toggleSkipped } from "../lib/setup-steps";

/** Where each step's action goes: the control on this page, or the guide for the part that happens in the desktop app. */
const STEP_TARGET: Record<SetupStepId, string> = {
    agent: "/docs/devices#coding-agents-on-a-computer",
    pair: "#devices-pairing",
    ssh: "#devices-ssh",
};

class StaleAccountError extends Error {}

/**
 * First-run setup. The web only explains and links: pairing and agent installs happen in the desktop app's own
 * window, so nothing here makes the desktop do anything.
 */
const SetupChecklist: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { authClient } = useAuth();
    const { data: session } = authClient.useSession();
    const queryClient = useQueryClient();
    // Who is signed in right now, read when a queued save runs: a click belongs to the account that made it.
    const signedInRef = useRef(session?.user?.id);

    useEffect(() => {
        signedInRef.current = session?.user?.id;
    }, [session?.user?.id]);
    const devicesQuery = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const settingsQuery = useUserSettings();
    const settingsKey = crpc.auth.functions.getUserSettings.queryOptions({}).queryKey;
    // One step per call: the server applies it to the list it holds, so another tab's skip is never overwritten. The
    // cache is patched one step at a time, never from an earlier snapshot. Two cases read the server instead of guessing:
    // an account with no settings row yet (nothing to patch) and a failed save (whatever is stored is what to show).
    // The live settings query answers a refetch from its open subscription, which still holds the value from before the
    // write until the server's push arrives, and that would put the old list back over the click. So the stored list is read
    // once, straight from the server, and written into the shared cache; the push that follows carries the same list.
    const storedSettings = crpc.auth.functions.getUserSettings.queryOptions({}, { live: false });
    const unsettledSaves = useRef(0);
    const reloadSettings = async () => {
        if (unsettledSaves.current > 0) {
            // A later save is queued behind this one: its own settle reads the list that includes both.
            return;
        }

        try {
            const stored = await (storedSettings.queryFn as (() => Promise<unknown>) | undefined)?.();

            if (unsettledSaves.current === 0) {
                queryClient.setQueryData(settingsKey, stored ?? null);
            }
        } catch {
            // Say so through the query's own error state, which has the retry.
            await queryClient.invalidateQueries({ queryKey: settingsKey });
        }
    };
    const saveStep = crpc.auth.setup_steps.setSetupStepSkipped.mutationOptions();
    const setSkipped = useMutation({
        ...saveStep,
        // Saves run one after another in click order, so a Skip still on its way can never land after the Resume that followed it.
        scope: { id: "setup-steps-skip" },
        // A save for an account that is no longer signed in is dropped before it is sent.
        mutationFn: async ({ owner, ...step }: SkipVariables, context) => {
            if (owner !== signedInRef.current) {
                throw new StaleAccountError();
            }

            return (await saveStep.mutationFn?.(step as never, context)) ?? null;
        },
        onMutate: async (args: SkipVariables) => {
            unsettledSaves.current += 1;

            if (args.owner !== signedInRef.current) {
                return { stale: true };
            }

            // A read still in flight would land after the patch with the value from before the click.
            await queryClient.cancelQueries({ queryKey: settingsKey });

            const row = queryClient.getQueryData<{ setupStepsSkipped?: string[] } | null>(settingsKey);

            if (row) {
                queryClient.setQueryData(settingsKey, { ...row, setupStepsSkipped: toggleSkipped(row.setupStepsSkipped, args.stepId, args.skipped) });
            }

            return { stale: false };
        },
        onError: (_error, args: SkipVariables, context) => {
            // The account changed: the cache now belongs to the new one, so nothing is rolled back, reread or announced.
            if (context?.stale || args.owner !== signedInRef.current) {
                return;
            }

            // Back to what the click replaced right away; the read that follows settles on whatever is stored.
            queryClient.setQueryData<{ setupStepsSkipped?: string[] } | null>(settingsKey, (row) =>
                row ? { ...row, setupStepsSkipped: toggleSkipped(row.setupStepsSkipped, args.stepId, !args.skipped) } : row,
            );
            toast.error(t`Could not save that choice. Try again.`);
        },
        // Settled either way, the stored list is what the card shows: a read that started before the write cannot outlive it.
        onSettled: async (_data, _error, args: SkipVariables, context) => {
            unsettledSaves.current -= 1;

            if (!context?.stale && args.owner === signedInRef.current) {
                await reloadSettings();
            }
        },
    });
    // An account with no settings row answers `null`; only `undefined` means the read has not finished. Until both reads
    // have answered, no step has a status: a skip that is stored but not yet read must not show as "To do".
    const settingsLoaded = settingsQuery.data !== undefined;
    const steps = settingsLoaded && devicesQuery.isSuccess ? deriveSetupSteps(devicesQuery.data, settingsQuery.data?.setupStepsSkipped) : undefined;

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
                <ol aria-label={t`Coding setup steps`} className="space-y-3">
                    {(
                        steps ??
                        SETUP_STEP_IDS.map((id) => {
                            return { id, status: undefined };
                        })
                    ).map(({ id, status }) => (
                        <li className="flex flex-wrap items-center gap-3" key={id}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">
                                    {status === "done" && <Check aria-hidden="true" className="mr-1 inline size-4" />}
                                    {copy[id].title} <span className="text-muted-foreground font-normal">({status ? statusLabel[status] : pendingLabel})</span>
                                </p>
                                <p className="text-muted-foreground text-xs">{copy[id].description}</p>
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
                                                setSkipped.mutate({ owner: signedInRef.current, skipped: status === "todo", stepId: id });
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
                        <p className="text-destructive text-xs">{t`Could not load your saved choices, so Skip and Resume are off until it is read again. The steps show what was last saved.`}</p>
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
