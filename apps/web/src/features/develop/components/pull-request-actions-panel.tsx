"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useState } from "react";

import { safeExternalUrl } from "../lib/format";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestActions } from "../lib/use-pull-request-actions";
import type { WriteResult } from "../lib/use-review-messages";
import { useReviewMessages } from "../lib/use-review-messages";

type Feedback = { kind: "error"; text: string } | { href?: string; kind: "success"; text: string };

const SEPARATORS = /[\s,]+/u;
const LEADING_AT = /^@/u;

/** Splits what the person typed into logins: commas or spaces, an optional leading @. */
const parseLogins = (input: string): string[] =>
    input
        .split(SEPARATORS)
        .map((login) => login.replace(LEADING_AT, "").trim())
        .filter((login) => login !== "");

/**
 * Edit the title and description, request reviewers, and revert a merged pull request. Each is
 * shown only where the capability report declares it, and each asks first: the forms confirm with
 * their own button, the revert with a dialog that names what it opens.
 */
const PullRequestActionsPanel = ({
    address,
    body,
    bodyTruncated,
    capabilities,
    hostLabel,
    requestNoun,
    state,
    title,
}: {
    address: PullRequestAddress;
    body: string;
    /** The host cut the description short: saving it would write the cut text back, so it stays as it is. */
    bodyTruncated: boolean;
    capabilities: HostCapabilityReportInput;
    hostLabel: string;
    requestNoun: string;
    state: "closed" | "merged" | "open";
    title: string;
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const messages = useReviewMessages(hostLabel);
    const actions = usePullRequestActions(address);
    const canEdit = isHostCapabilityAvailable(capabilities, "pullRequest.edit");
    const canReview = isHostCapabilityAvailable(capabilities, "reviewers.request") && state === "open";
    const canRevert = isHostCapabilityAvailable(capabilities, "pullRequest.revert") && state === "merged";
    const [editing, setEditing] = useState<{ body: string; title: string } | null>(null);
    const [reviewing, setReviewing] = useState<string | null>(null);
    const [reverting, setReverting] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    if (!canEdit && !canReview && !canRevert) {
        return null;
    }

    const busy = actions.edit.isPending || actions.requestReviewers.isPending || actions.revert.isPending;

    const failedText = (outcome: WriteResult | undefined) =>
        outcome === undefined ? t`Could not confirm that. Check on ${hostLabel} before you try again.` : messages.write(outcome);

    const saveEdit = async () => {
        if (editing === null) {
            return;
        }

        const change = {
            ...(editing.title !== title && { title: editing.title }),
            ...(!bodyTruncated && editing.body !== body && { body: editing.body }),
        };

        setEditing(null);
        setFeedback(null);

        if (Object.keys(change).length === 0) {
            return;
        }

        const outcome = await actions.edit.mutateAsync(change).catch(() => undefined);

        setFeedback(outcome?.status === "ok" ? { kind: "success", text: t`Saved on ${hostLabel}.` } : { kind: "error", text: failedText(outcome) });
    };

    const sendReviewers = async () => {
        const logins = parseLogins(reviewing ?? "");

        setReviewing(null);
        setFeedback(null);

        if (logins.length === 0) {
            return;
        }

        const outcome = await actions.requestReviewers.mutateAsync(logins).catch(() => undefined);

        setFeedback(outcome?.status === "ok" ? { kind: "success", text: t`Review requested.` } : { kind: "error", text: failedText(outcome) });
    };

    const revertNow = async () => {
        setReverting(false);
        setFeedback(null);

        const outcome = await actions.revert.mutateAsync().catch(() => undefined);

        if (outcome?.status === "ok") {
            // Only a link the host gave, checked again before it is shown as an address to open.
            setFeedback({ kind: "success", href: safeExternalUrl(outcome.url) ?? undefined, text: t`Opened a revert pull request on ${hostLabel}.` });
        } else {
            setFeedback({ kind: "error", text: failedText(outcome) });
        }
    };

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={titleId}>
                {t`Pull request`}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                    <Button disabled={busy} onClick={() => setEditing({ body, title })} variant="outline">
                        {t`Edit title and description`}
                    </Button>
                )}
                {canReview && (
                    <Button disabled={busy} onClick={() => setReviewing("")} variant="outline">
                        {t`Request reviewers`}
                    </Button>
                )}
                {canRevert && (
                    <Button disabled={busy} onClick={() => setReverting(true)} variant="outline">
                        {t`Revert`}
                    </Button>
                )}
            </div>
            <div aria-live="polite" role="status">
                {feedback?.kind === "success" && (
                    <p className="text-sm">
                        {feedback.text}
                        {feedback.href !== undefined && (
                            <>
                                {" "}
                                <a className="underline" href={feedback.href} rel="noreferrer" target="_blank">
                                    {t`Open`}
                                </a>
                            </>
                        )}
                    </p>
                )}
            </div>
            {feedback?.kind === "error" && (
                <Alert role="alert" variant="destructive">
                    <AlertTitle>{t`Not changed`}</AlertTitle>
                    <AlertDescription>{feedback.text}</AlertDescription>
                </Alert>
            )}

            <Dialog onOpenChange={(open) => !open && setEditing(null)} open={editing !== null}>
                <DialogPopup>
                    <DialogHeader>
                        <DialogTitle>{t`Edit this ${requestNoun}`}</DialogTitle>
                        <DialogDescription>{t`${hostLabel} shows the new title and description to everyone who can see this ${requestNoun}.`}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 px-6">
                        <div className="space-y-1">
                            <Label htmlFor={`${titleId}-title`}>{t`Title`}</Label>
                            <Input
                                id={`${titleId}-title`}
                                onChange={(event) =>
                                    setEditing((current) => {
                                        return { body: current?.body ?? body, title: event.target.value };
                                    })
                                }
                                value={editing?.title ?? ""}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor={`${titleId}-body`}>{t`Description`}</Label>
                            <Textarea
                                disabled={bodyTruncated}
                                id={`${titleId}-body`}
                                onChange={(event) =>
                                    setEditing((current) => {
                                        return { body: event.target.value, title: current?.title ?? title };
                                    })
                                }
                                rows={8}
                                value={editing?.body ?? ""}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Cancel`}</DialogClose>
                        <Button disabled={(editing?.title ?? "").trim() === ""} onClick={saveEdit}>{t`Save`}</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>

            <Dialog onOpenChange={(open) => !open && setReviewing(null)} open={reviewing !== null}>
                <DialogPopup>
                    <DialogHeader>
                        <DialogTitle>{t`Request reviewers`}</DialogTitle>
                        <DialogDescription>{t`Enter the logins of the people to ask. Reviewers already requested stay requested.`}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1 px-6">
                        <Label htmlFor={`${titleId}-logins`}>{t`Logins`}</Label>
                        <Input id={`${titleId}-logins`} onChange={(event) => setReviewing(event.target.value)} value={reviewing ?? ""} />
                    </div>
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Cancel`}</DialogClose>
                        <Button disabled={parseLogins(reviewing ?? "").length === 0} onClick={sendReviewers}>{t`Request`}</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>

            <ConfirmDialog
                confirmLabel={t`Open revert`}
                description={t`${hostLabel} opens a new ${requestNoun} that undoes the merged change. It is a separate change for you to review and merge.`}
                onConfirm={revertNow}
                onOpenChange={(open) => !open && setReverting(false)}
                open={reverting}
                title={t`Open a revert of this ${requestNoun}?`}
            />
        </section>
    );
};

export default PullRequestActionsPanel;
