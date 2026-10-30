"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { MergeMethod, MergeState } from "@neore/backend/source-control/types";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { useId, useState } from "react";

import { methodToUse } from "../lib/merge";
import type { PullRequestAddress } from "../lib/use-develop";
import { useChecksAndMergeActions, useMergeStatus } from "../lib/use-merge";
import { useReviewMessages } from "../lib/use-review-messages";
import FailureNotice from "./failure-notice";

type Pending = "auto" | "autoOff" | "merge";

type Feedback = { kind: "error"; text: string } | { kind: "success"; text: string };

/**
 * Merge, and merge-when-ready, for an open change. Both ask first, name the method and the commit
 * being merged, and are shown only where the capability report declares them. The host decides
 * whether its rules allow it; when it refuses, its reason is what is shown here.
 */
const MergePanel = ({
    address,
    capabilities,
    headSha,
    hostLabel,
    requestNoun,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    headSha: string;
    hostLabel: string;
    requestNoun: string;
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const messages = useReviewMessages(hostLabel);
    const canMerge = isHostCapabilityAvailable(capabilities, "merge.now");
    const canAutoMerge = isHostCapabilityAvailable(capabilities, "merge.auto");
    const status = useMergeStatus(address, canMerge);
    const actions = useChecksAndMergeActions(address);
    const [chosen, setChosen] = useState<MergeMethod | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    if (!canMerge || status.isPending) {
        return null;
    }

    if (status.isError) {
        return <FailureNotice label={hostLabel} status="host_error" />;
    }

    if (status.data.status !== "ok") {
        return <FailureNotice label={hostLabel} status={status.data.status} />;
    }

    const { autoMergeAllowed, autoMergeEnabled, methods, state } = status.data;
    const method = methodToUse(methods, chosen);

    if (method === null) {
        // The repository's settings come back only to some accounts: say so rather than show no merge at all.
        return <p className="text-muted-foreground text-sm">{t`${hostLabel} does not show which ways of merging this repository allows to your account.`}</p>;
    }

    const methodLabels: Record<MergeMethod, string> = { merge: t`Merge commit`, rebase: t`Rebase and merge`, squash: t`Squash and merge` };
    const stateHints: Record<MergeState, string> = {
        behind: t`This branch is behind its base branch.`,
        blocked: t`${hostLabel} has rules this ${requestNoun} does not meet yet. You can still try: ${hostLabel} will say what is missing.`,
        clean: t`${hostLabel} says this is ready to merge.`,
        conflicting: t`This branch has conflicts with its base branch.`,
        draft: t`This ${requestNoun} is still a draft.`,
        unknown: "",
        unstable: t`Checks that are not required are failing.`,
    };
    const busy = actions.merge.isPending || actions.autoMerge.isPending;

    const run = async () => {
        const action = pending;

        setPending(null);
        setFeedback(null);

        if (action === "merge") {
            const outcome = await actions.merge.mutateAsync({ headSha, method }).catch(() => undefined);

            if (outcome === undefined) {
                setFeedback({ kind: "error", text: t`Could not confirm that this was merged. Check on ${hostLabel} before you try again.` });
            } else if (outcome.status === "ok") {
                setFeedback({ kind: "success", text: t`Merged on ${hostLabel}.` });
            } else {
                setFeedback({ kind: "error", text: messages.write(outcome) });
            }

            return;
        }

        const enabled = action === "auto";
        const outcome = await actions.autoMerge.mutateAsync({ enabled, method }).catch(() => undefined);

        if (outcome === undefined) {
            setFeedback({ kind: "error", text: t`Could not confirm the change to auto-merge. Check on ${hostLabel} before you try again.` });
        } else if (outcome.status === "ok") {
            setFeedback({ kind: "success", text: enabled ? t`Auto-merge is on.` : t`Auto-merge is off.` });
        } else {
            setFeedback({ kind: "error", text: messages.write(outcome) });
        }
    };

    const dialogs: Record<Pending, { confirm: string; description: string; title: string }> = {
        auto: {
            confirm: t`Merge when ready`,
            description: t`${hostLabel} will merge this ${requestNoun} with “${methodLabels[method]}” once its rules are met. You can turn this off until then.`,
            title: t`Merge when ready?`,
        },
        autoOff: {
            confirm: t`Turn off`,
            description: t`This ${requestNoun} will no longer merge by itself.`,
            title: t`Turn off auto-merge?`,
        },
        merge: {
            confirm: t`Merge`,
            description: t`This merges the commit ${headSha.slice(0, 7)} into the base branch with “${methodLabels[method]}” on ${hostLabel}. If the branch has changed since you opened this page, ${hostLabel} refuses.`,
            title: t`Merge this ${requestNoun}?`,
        },
    };
    const dialog = pending === null ? null : dialogs[pending];

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={titleId}>
                {t`Merge`}
            </h3>
            {stateHints[state] !== "" && <p className="text-muted-foreground text-xs">{stateHints[state]}</p>}
            {methods.length > 1 && (
                <RadioGroup
                    aria-label={t`How to merge`}
                    className="flex flex-wrap gap-4"
                    disabled={busy}
                    onValueChange={(value) => setChosen(value as MergeMethod)}
                    value={method}
                >
                    {methods.map((candidate) => (
                        <div className="flex items-center gap-2 text-sm" key={candidate}>
                            <RadioGroupItem id={`${titleId}-${candidate}`} value={candidate} />
                            <label htmlFor={`${titleId}-${candidate}`}>{methodLabels[candidate]}</label>
                        </div>
                    ))}
                </RadioGroup>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => setPending("merge")}>
                    {actions.merge.isPending ? t`Merging…` : methodLabels[method]}
                </Button>
                {canAutoMerge && autoMergeAllowed && !autoMergeEnabled && (
                    <Button disabled={busy} onClick={() => setPending("auto")} variant="outline">
                        {t`Merge when ready`}
                    </Button>
                )}
                {canAutoMerge && autoMergeEnabled && (
                    <Button disabled={busy} onClick={() => setPending("autoOff")} variant="outline">
                        {t`Turn off auto-merge`}
                    </Button>
                )}
            </div>
            {canAutoMerge && autoMergeEnabled && <p className="text-muted-foreground text-xs">{t`Auto-merge is on: it merges once ${hostLabel}'s rules are met.`}</p>}
            <div aria-live="polite" role="status">
                {feedback?.kind === "success" && <p className="text-sm">{feedback.text}</p>}
            </div>
            {feedback?.kind === "error" && (
                <Alert role="alert" variant="destructive">
                    <AlertTitle>{t`Not merged`}</AlertTitle>
                    <AlertDescription>{feedback.text}</AlertDescription>
                </Alert>
            )}
            <ConfirmDialog
                confirmLabel={dialog?.confirm}
                description={dialog?.description}
                onConfirm={run}
                onOpenChange={(open) => {
                    if (!open) {
                        setPending(null);
                    }
                }}
                open={dialog !== null}
                title={dialog?.title ?? ""}
            />
        </section>
    );
};

export default MergePanel;
