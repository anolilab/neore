"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { useId, useState } from "react";

import type { Feedback } from "../lib/pull-request-action-feedback";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestActions } from "../lib/use-pull-request-actions";
import EditPullRequestAction from "./pull-request-edit-action";
import RevertPullRequestAction from "./pull-request-revert-action";
import ReviewersPullRequestAction from "./pull-request-reviewers-action";

/**
 * Edit the title and description, request reviewers, and revert a merged pull request. Each is shown only where the capability
 * report declares it, and each asks first: the forms confirm with their own button, the revert with a dialog that names what it opens.
 */
const PullRequestActionsPanel = ({
    host,
    pull,
}: {
    host: { capabilities: HostCapabilityReportInput; label: string; noun: string };
    pull: {
        address: PullRequestAddress;
        body: string;
        /** The host cut the description short: saving it would write the cut text back, so it stays as it is. */
        bodyTruncated: boolean;
        state: "closed" | "merged" | "open";
        title: string;
    };
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const actions = usePullRequestActions(pull.address);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const canEdit = isHostCapabilityAvailable(host.capabilities, "pullRequest.edit");
    const canReview = isHostCapabilityAvailable(host.capabilities, "reviewers.request") && pull.state === "open";
    const canRevert = isHostCapabilityAvailable(host.capabilities, "pullRequest.revert") && pull.state === "merged";

    if (!canEdit && !canReview && !canRevert) {
        return null;
    }

    const busy = actions.edit.isPending || actions.requestReviewers.isPending || actions.revert.isPending;

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={titleId}>
                {t`Pull request`}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                    <EditPullRequestAction
                        actions={actions}
                        body={pull.body}
                        bodyTruncated={pull.bodyTruncated}
                        busy={busy}
                        hostLabel={host.label}
                        onFeedback={setFeedback}
                        requestNoun={host.noun}
                        title={pull.title}
                    />
                )}
                {canReview && <ReviewersPullRequestAction actions={actions} busy={busy} hostLabel={host.label} onFeedback={setFeedback} />}
                {canRevert && <RevertPullRequestAction actions={actions} busy={busy} hostLabel={host.label} onFeedback={setFeedback} requestNoun={host.noun} />}
            </div>
            <div aria-live="polite" role="status">
                {busy && <p className="text-muted-foreground text-sm">{t`Working on ${host.label}…`}</p>}
                {!busy && feedback?.kind === "success" && (
                    <p className="text-sm">
                        {feedback.text}
                        {feedback.href !== undefined && (
                            <>
                                {" "}
                                <a
                                    aria-label={t`Open the revert pull request on ${host.label}`}
                                    className="underline"
                                    href={feedback.href}
                                    rel="noreferrer"
                                    target="_blank"
                                >
                                    {t`Open`}
                                </a>
                            </>
                        )}
                    </p>
                )}
            </div>
            {!busy && feedback?.kind === "error" && (
                <Alert role="alert" variant="destructive">
                    <AlertTitle>{feedback.unconfirmed ? t`Not confirmed` : t`Not changed`}</AlertTitle>
                    <AlertDescription>{feedback.text}</AlertDescription>
                </Alert>
            )}
        </section>
    );
};

export default PullRequestActionsPanel;
