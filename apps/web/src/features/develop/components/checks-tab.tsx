"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Skeleton } from "@neore/ui/components/skeleton";
import { useState } from "react";

import { safeExternalUrl } from "../lib/format";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestChecks } from "../lib/use-develop";
import { useChecksAndMergeActions } from "../lib/use-merge";
import { useReviewMessages } from "../lib/use-review-messages";
import FailureNotice from "./failure-notice";

type State = "cancelled" | "failure" | "neutral" | "pending" | "skipped" | "success";

const VARIANT: Record<State, "default" | "destructive" | "outline" | "secondary"> = {
    cancelled: "secondary",
    failure: "destructive",
    neutral: "secondary",
    pending: "outline",
    skipped: "secondary",
    success: "default",
};

interface Target {
    id: string;
    name: string;
}

const ChecksTab = ({
    address,
    capabilities,
    headSha,
    hostLabel,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    headSha: string;
    hostLabel: string;
}) => {
    const { t } = useLingui();
    const checks = usePullRequestChecks(address, headSha, true);
    const actions = useChecksAndMergeActions(address);
    const messages = useReviewMessages(hostLabel);
    const [target, setTarget] = useState<Target | null>(null);
    const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);

    if (checks.isPending) {
        return <Skeleton aria-label={t`Loading checks`} className="h-24 w-full" role="status" />;
    }

    if (checks.isError) {
        return <FailureNotice label={hostLabel} status="host_error" />;
    }

    if (checks.data.status !== "ok") {
        return <FailureNotice label={hostLabel} status={checks.data.status} />;
    }

    const { checks: list, rollup, total } = checks.data;

    if (list.length === 0 && total === 0 && rollup.waiting.length === 0) {
        return <p className="text-muted-foreground text-sm">{t`No checks have run for this commit.`}</p>;
    }

    const canRerun = isHostCapabilityAvailable(capabilities, "checks.rerun");
    const knowsRequired = isHostCapabilityAvailable(capabilities, "checks.requiredState");
    const labels: Record<State, string> = {
        cancelled: t`Cancelled`,
        failure: t`Failed`,
        neutral: t`Neutral`,
        pending: t`Pending`,
        skipped: t`Skipped`,
        success: t`Passed`,
    };
    // A check whose requirement could not be read counts as required, so the wording must not claim it is.
    const unsure = list.some((check) => check.required === null);
    const waiting = rollup.waiting.length > 0 ? t`Waiting for ${rollup.waiting.join(", ")}.` : "";
    const withWaiting = (running: string) => [rollup.pending > 0 ? running : "", waiting].filter(Boolean).join(" ");
    const plainSummaries = {
        failing: plural(rollup.failing, { one: "# check is failing", other: "# checks are failing" }),
        none: "",
        passing: t`All checks passed.`,
        pending: withWaiting(plural(rollup.pending, { one: "# check is still running", other: "# checks are still running" })),
    };
    const requiredSummaries = {
        failing: plural(rollup.failing, { one: "# required check is failing", other: "# required checks are failing" }),
        none: "",
        passing: t`All required checks passed.`,
        pending: withWaiting(plural(rollup.pending, { one: "# required check is still running", other: "# required checks are still running" })),
    };
    const unsureSummaries = {
        failing: plural(rollup.failing, { one: "# required or unknown check is failing", other: "# required or unknown checks are failing" }),
        none: "",
        passing: t`All required or unknown checks passed.`,
        pending: withWaiting(
            plural(rollup.pending, { one: "# required or unknown check is still running", other: "# required or unknown checks are still running" }),
        ),
    };
    let summaries = plainSummaries;

    if (knowsRequired) {
        summaries = unsure ? unsureSummaries : requiredSummaries;
    }

    const rerun = async () => {
        if (target === null) {
            return;
        }

        setTarget(null);
        setFeedback(null);

        const outcome = await actions.rerun.mutateAsync(target.id).catch(() => undefined);

        if (outcome === undefined) {
            setFeedback({ kind: "error", text: t`Could not confirm that ${target.name} was started again. Check on ${hostLabel} before you try again.` });
        } else if (outcome.status === "ok") {
            setFeedback({ kind: "success", text: t`${target.name} was started again.` });
        } else {
            setFeedback({ kind: "error", text: messages.write(outcome) });
        }
    };

    return (
        <div className="space-y-3">
            <p
                className={rollup.state === "failing" ? "text-destructive text-sm font-medium" : "text-sm font-medium"}
                role={rollup.state === "failing" ? "alert" : "status"}
            >
                {rollup.state === "passing" && !rollup.complete ? t`No failures in the checks shown.` : summaries[rollup.state]}
                {knowsRequired && rollup.optionalFailing > 0 && (
                    <span className="text-muted-foreground font-normal">
                        {" "}
                        {plural(rollup.optionalFailing, { one: "# optional check failed.", other: "# optional checks failed." })}
                    </span>
                )}
            </p>
            {(total > list.length || !rollup.complete) && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                    {t`Showing ${list.length} of ${plural(total, { one: "# check", other: "# checks" })}.`}
                </p>
            )}
            <ul className="rounded-md border">
                {list.map((check, index) => {
                    const href = safeExternalUrl(check.url);
                    const checkId = check.id;

                    return (
                        // A check name is not unique across runs and statuses, so the position keeps the key stable.

                        // eslint-disable-next-line react-x/no-array-index-key
                        <li className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0" key={`${check.name}-${index}`}>
                            <Badge variant={VARIANT[check.state]}>{labels[check.state]}</Badge>
                            {href ? (
                                <a className="min-w-0 flex-1 truncate hover:underline" href={href} rel="noopener noreferrer" target="_blank">
                                    {check.name}
                                </a>
                            ) : (
                                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                            )}
                            {knowsRequired && check.required === true && <Badge variant="outline">{t`Required`}</Badge>}
                            {knowsRequired && check.required === false && <Badge variant="secondary">{t`Optional`}</Badge>}
                            {canRerun && checkId !== null && (
                                <Button
                                    aria-label={t`Re-run ${check.name}`}
                                    disabled={actions.rerun.isPending || check.state === "pending"}
                                    onClick={() => setTarget({ id: checkId, name: check.name })}
                                    size="sm"
                                    variant="ghost"
                                >
                                    {t`Re-run`}
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
            <div aria-live="polite" role="status">
                {feedback?.kind === "success" && <p className="text-sm">{feedback.text}</p>}
            </div>
            {feedback?.kind === "error" && (
                <Alert role="alert" variant="destructive">
                    <AlertTitle>{t`Not re-run`}</AlertTitle>
                    <AlertDescription>{feedback.text}</AlertDescription>
                </Alert>
            )}
            <ConfirmDialog
                confirmLabel={t`Re-run`}
                description={t`Only this check is started again on ${hostLabel}, not the rest of its workflow.`}
                onConfirm={rerun}
                onOpenChange={(open) => {
                    if (!open) {
                        setTarget(null);
                    }
                }}
                open={target !== null}
                title={t`Re-run ${target?.name ?? ""}?`}
            />
        </div>
    );
};

export default ChecksTab;
