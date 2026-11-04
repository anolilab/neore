"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { useState } from "react";

import { safeExternalUrl } from "../lib/format";
import type { Feedback } from "../lib/pull-request-action-feedback";
import { attempt, useActionFeedback, useSingleFlight } from "../lib/pull-request-action-feedback";
import type { PullRequestActions } from "../lib/use-pull-request-actions";

/** Opening a revert of a merged pull request: its button, and the confirmation that names what it opens. */
const RevertPullRequestAction = ({
    actions,
    busy,
    hostLabel,
    onFeedback,
    requestNoun,
}: {
    actions: PullRequestActions;
    busy: boolean;
    hostLabel: string;
    onFeedback: (feedback: Feedback | null) => void;
    requestNoun: string;
}) => {
    const { t } = useLingui();
    const { failure, thrownFailure } = useActionFeedback(hostLabel);
    const singleFlight = useSingleFlight();
    const [reverting, setReverting] = useState(false);

    const submitRevert = async () => {
        setReverting(false);
        onFeedback(null);

        const result = await attempt(actions.revert.mutateAsync());

        if ("thrown" in result) {
            onFeedback(thrownFailure(result.thrown));
        } else if (result.outcome.status === "ok") {
            // Only a link the host gave, checked again before it is shown as an address to open.
            onFeedback({
                kind: "success",
                href: safeExternalUrl(result.outcome.url) ?? undefined,
                text: t`Opened a revert pull request on ${hostLabel}.`,
            });
        } else {
            onFeedback(failure(result.outcome));
        }
    };

    // A second revert must not open a second revert pull request: each is guarded on its click.
    const revertNow = singleFlight("revert", submitRevert);

    return (
        <>
            <Button disabled={busy} onClick={() => setReverting(true)} variant="outline">
                {t`Revert`}
            </Button>
            <ConfirmDialog
                confirmLabel={t`Open revert`}
                description={t`${hostLabel} opens a new ${requestNoun} that undoes the merged change. It is a separate change for you to review and merge.`}
                loading={actions.revert.isPending}
                onConfirm={revertNow}
                onOpenChange={(open) => !open && setReverting(false)}
                open={reverting}
                title={t`Open a revert of this ${requestNoun}?`}
            />
        </>
    );
};

export default RevertPullRequestAction;
