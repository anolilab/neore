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
    const { settled } = useActionFeedback(hostLabel);
    const singleFlight = useSingleFlight();
    const [confirming, setConfirming] = useState(false);

    const submit = async () => {
        setConfirming(false);
        onFeedback(null);

        const result = await attempt(actions.revert.mutateAsync());
        // The server keeps only a link on the host's web origin; it is checked here again before it is shown as an address to open.
        const href = "outcome" in result && result.outcome.status === "ok" ? safeExternalUrl(result.outcome.url) : undefined;

        onFeedback(settled(result, { href, kind: "success", text: t`Opened a revert ${requestNoun} on ${hostLabel}.` }));
    };

    // A second click must not open a second revert: each is guarded on its click.
    const revert = singleFlight("revert", submit);

    return (
        <>
            <Button disabled={busy} onClick={() => setConfirming(true)} variant="outline">
                {actions.revert.isPending ? t`Reverting…` : t`Revert`}
            </Button>
            <ConfirmDialog
                confirmLabel={t`Open revert`}
                description={t`${hostLabel} opens a new ${requestNoun} that undoes the merged change. It is a separate change for you to review and merge.`}
                loading={actions.revert.isPending}
                onConfirm={revert}
                onOpenChange={(open) => !open && setConfirming(false)}
                open={confirming}
                title={t`Open a revert of this ${requestNoun}?`}
            />
        </>
    );
};

export default RevertPullRequestAction;
