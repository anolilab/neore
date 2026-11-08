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

/**
 * The writes a person can make to a pull request. Each is shown only where the capability report declares it, and each asks
 * first: the form confirms with its own button.
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
        title: string;
    };
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const actions = usePullRequestActions(pull.address);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    if (!isHostCapabilityAvailable(host.capabilities, "pullRequest.edit")) {
        return null;
    }

    const busy = actions.edit.isPending;

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={titleId}>
                {t`Pull request`}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
            <div aria-live="polite" role="status">
                {busy && <p className="text-muted-foreground text-sm">{t`Working on ${host.label}…`}</p>}
                {!busy && feedback?.kind === "success" && <p className="text-sm">{feedback.text}</p>}
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
