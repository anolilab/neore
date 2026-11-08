import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import type { SetupStepId, SetupStepStatus } from "../lib/setup-steps";
import { deriveSetupSteps, SETUP_STEP_IDS, toggleSkipped } from "../lib/setup-steps";

/** Where each step's action goes: the control on this page, or the guide for the part that happens in the desktop app. */
const STEP_TARGET: Record<SetupStepId, string> = {
    agent: "/docs/devices#coding-agents-on-a-computer",
    pair: "#devices-pairing",
    ssh: "#devices-ssh",
};

type SkippedRow = { setupStepsSkipped?: string[] } | null | undefined;

const SAVE_SCOPE = "setup-steps-skip";

/** A click carries the account that made it, so a save queued behind others never runs as someone who signed in since. */
interface SkipVariables {
    owner: string | undefined;
    skipped: boolean;
    stepId: SetupStepId;
}

class StaleAccountError extends Error {}

/**
 * First-run setup. The web only explains and links: pairing and agent installs happen in the desktop app's own
 * window, so nothing here makes the desktop do anything. `serverFormShown` says whether the servers card is on this page.
 */
const SetupChecklist: FC<{ serverFormShown: boolean }> = ({ serverFormShown }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const settingsQuery = useUserSettings();
    const settingsKey = crpc.auth.functions.getUserSettings.queryOptions({}).queryKey;
    // The step whose last save was refused: the message stays beside it after the toast has gone.
    const [failedStep, setFailedStep] = useState<SetupStepId | undefined>(undefined);
    const { authClient } = useAuth();
    const { data: session } = authClient.useSession();
    // Who is signed in right now, read when a queued save runs.
    const signedInRef = useRef(session?.user?.id);

    useEffect(() => {
        signedInRef.current = session?.user?.id;
    }, [session?.user?.id]);

    // The list is live: a computer paired in the desktop app arrives as a push.
    const devicesQuery = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const saveStep = crpc.auth.setup_steps.setSetupStepSkipped.mutationOptions();
    // One step per call: the server applies it to the list it holds, so another tab's skip is never overwritten.
    const setSkipped = useMutation({
        ...saveStep,
        // Saves run in click order, so a Skip still on its way can never land after the Resume that followed it.
        mutationKey: [SAVE_SCOPE],
        scope: { id: SAVE_SCOPE },
        mutationFn: async (args: SkipVariables, context) => {
            const { owner, ...step } = args;

            if (owner !== signedInRef.current) {
                throw new StaleAccountError();
            }

            return (await saveStep.mutationFn?.(step as never, context)) ?? null;
        },
        onMutate: async (args) => {
            if (args.owner !== signedInRef.current) {
                return undefined;
            }

            setFailedStep(undefined);
            // A read still in flight would land after the patch with the value from before the click.
            await queryClient.cancelQueries({ queryKey: settingsKey });

            // An account with no settings row reads `null`: the click still shows, and an error puts the null back.
            const row = queryClient.getQueryData<SkippedRow>(settingsKey);
            const wasSkipped = row?.setupStepsSkipped?.includes(args.stepId) === true;

            const patched: SkippedRow = { ...row, setupStepsSkipped: toggleSkipped(row?.setupStepsSkipped, args.stepId, args.skipped) };

            queryClient.setQueryData<SkippedRow>(settingsKey, () => patched);

            return { hadRow: Boolean(row), wasSkipped };
        },
        onError: (_error, args, context) => {
            // Another account is signed in now: the cache is theirs, so nothing is restored or announced.
            if (context === undefined || args.owner !== signedInRef.current) {
                return;
            }

            // Only this step goes back to its own previous value; a choice made on another step since stays.
            queryClient.setQueryData<SkippedRow>(settingsKey, (row) => {
                const list = toggleSkipped(row?.setupStepsSkipped, args.stepId, context.wasSkipped);

                return context.hadRow || list.length > 0 ? { ...row, setupStepsSkipped: list } : null;
            });
            setFailedStep(args.stepId);
            toast.error(t`Could not save that choice. Try again.`);
        },
        // Settled, the cache ends on what the server stores, once no later save is still waiting its turn.
        onSettled: async (_data, _error, args) => {
            if (args.owner === signedInRef.current && queryClient.isMutating({ mutationKey: [SAVE_SCOPE] }) <= 1) {
                await queryClient.invalidateQueries({ queryKey: settingsKey });
            }
        },
    });
    // An account with no settings row answers `null`; only `undefined` means the read has not finished. Until both reads
    // have answered, no step has a status: a skip that is stored but not yet read must not show as "To do".
    // Cached results from before this mount (another account's, say) are not answers: both reads must have been fetched since.
    const steps =
        settingsQuery.isFetchedAfterMount && settingsQuery.data !== undefined && devicesQuery.isFetchedAfterMount && devicesQuery.isSuccess
            ? deriveSetupSteps(devicesQuery.data, settingsQuery.data?.setupStepsSkipped)
            : undefined;

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
            description: t`Let the agent work on a server you reach over SSH. Needs a paired computer, and the form to add one is in the desktop app.`,
            title: t`Add an SSH server`,
        },
    };
    const statusLabel = { done: t`Done`, skipped: t`Skipped`, todo: t`To do` };
    const announce = (status: SetupStepStatus, title: string) => {
        if (status === "done") {
            return t`${title} is done.`;
        }

        return status === "skipped" ? t`${title} is skipped.` : t`${title} is to do.`;
    };
    const [seen, setSeen] = useState<{ key: string; steps: NonNullable<typeof steps> } | undefined>(undefined);
    const [announcement, setAnnouncement] = useState("");
    const statusKey = steps?.map((step) => step.status).join(",");

    // Said once when a status changes after the first read: a device completing a step, Skip, Resume. The first read is silent.
    if (steps !== undefined && statusKey !== undefined && seen?.key !== statusKey) {
        setSeen({ key: statusKey, steps });

        if (seen) {
            setAnnouncement(
                steps
                    .filter((step, index) => step.status !== seen.steps[index]?.status)
                    .map((step) => announce(step.status, copy[step.id].title))
                    .join(" "),
            );
        }
    }

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
                                {failedStep === id && <p className="text-destructive mt-1 text-xs">{t`Could not save that choice. Try again.`}</p>}
                            </div>
                            {/* The links stay while the device check is pending or failed; only Skip and Resume need a known status. */}
                            {status !== "done" && (
                                <>
                                    {(id !== "ssh" || serverFormShown) && (
                                        <a className={buttonVariants({ size: "sm", variant: "outline" })} href={STEP_TARGET[id]}>
                                            {copy[id].action}
                                            <span className="sr-only">: {copy[id].title}</span>
                                        </a>
                                    )}
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
                <p className="sr-only" role="status">
                    {announcement}
                </p>
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
