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
import { useId, useRef, useState } from "react";

import { safeExternalUrl } from "../lib/format";
import type { PullRequestAddress } from "../lib/use-develop";
import { isPreHostRefusal, usePullRequestActions } from "../lib/use-pull-request-actions";
import type { WriteResult } from "../lib/use-review-messages";
import { useReviewMessages } from "../lib/use-review-messages";

/** The answer of a write, or the error it threw: a refusal the server named is a thrown coded error, a lost answer is not. */
async function attempt<T>(promise: Promise<T>): Promise<{ outcome: T } | { thrown: unknown }> {
    try {
        return { outcome: await promise };
    } catch (error) {
        return { thrown: error };
    }
}

/**
 * Each handler it wraps runs once at a time: a run is refused while the previous one of the same name is in flight. The flag is
 * set when the handler is called, which a disabled button cannot do: it turns off only after the next render, so a second click
 * can arrive before it.
 */
const useSingleFlight = () => {
    const inFlight = useRef<Record<string, boolean>>({});

    return (name: string, run: () => Promise<void>) => async (): Promise<void> => {
        if (inFlight.current[name] === true) {
            return;
        }

        inFlight.current[name] = true;

        try {
            await run();
        } finally {
            inFlight.current[name] = false;
        }
    };
};

type Feedback = { kind: "error"; text: string; unconfirmed: boolean } | { href?: string; kind: "success"; text: string };

/** The same login rule the backend applies, so a bad name is refused here with its reason. */
const LOGIN = /^[A-Za-z0-9](?:\w|-\b){0,38}$/u;
const MAX_REVIEWERS = 15;
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
    const singleFlight = useSingleFlight();
    const canEdit = isHostCapabilityAvailable(capabilities, "pullRequest.edit");
    const canReview = isHostCapabilityAvailable(capabilities, "reviewers.request") && state === "open";
    const canRevert = isHostCapabilityAvailable(capabilities, "pullRequest.revert") && state === "merged";
    // `original` is the page as it was when the dialog opened: a later refetch must not turn an untouched field into a write.
    // `truncated` is captured when the dialog opens: a refetch during the edit must not change what Save writes.
    const [editing, setEditing] = useState<{ body: string; original: { body: string; title: string }; title: string; truncated: boolean } | null>(null);
    // A refused save keeps the dialog open with its reason, so the typed text is still there to correct.
    const [editProblem, setEditProblem] = useState<string | null>(null);
    const [reviewing, setReviewing] = useState<string | null>(null);
    const [reviewProblem, setReviewProblem] = useState<string | null>(null);
    const [reverting, setReverting] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    if (!canEdit && !canReview && !canRevert) {
        return null;
    }

    const titleEmpty = (editing?.title ?? "").trim() === "";
    const bodyLocked = editing?.truncated === true;
    const busy = actions.edit.isPending || actions.requestReviewers.isPending || actions.revert.isPending;

    // Only an error the server raised before any host call says nothing changed; any other thrown error may have reached the host.
    const thrownFailure = (thrown: unknown): Feedback =>
        isPreHostRefusal(thrown)
            ? { kind: "error", text: t`The request was refused before it reached ${hostLabel}. Nothing was changed.`, unconfirmed: false }
            : { kind: "error", text: t`Could not confirm that. Check on ${hostLabel} before you try again.`, unconfirmed: true };

    // A host answer that is not ok: refused, or marked unconfirmed (its answer never came back).
    const failure = (outcome: WriteResult): Feedback => {
        return {
            kind: "error",
            text: messages.write(outcome),
            unconfirmed: outcome.status === "unconfirmed",
        };
    };

    // The feedback for a write's answer: the success text when the host took it, otherwise the refusal or the unconfirmed answer.
    const settled = (result: { outcome: WriteResult } | { thrown: unknown }, success: Feedback): Feedback => {
        if ("thrown" in result) {
            return thrownFailure(result.thrown);
        }

        return result.outcome.status === "ok" ? success : failure(result.outcome);
    };

    const reviewerProblem = (logins: string[]): string | null => {
        if (logins.length > MAX_REVIEWERS) {
            return t`Request at most ${MAX_REVIEWERS} reviewers at a time.`;
        }

        return logins.every((login) => LOGIN.test(login))
            ? null
            : t`Logins use letters, digits, single hyphens or underscores. A hyphen cannot start or end a login, or come twice in a row.`;
    };

    const submitEdit = async () => {
        if (editing === null) {
            return;
        }

        // The title is compared as typed: an untouched title with surrounding spaces must not be sent trimmed in a description-only save.
        const change = {
            ...(editing.title !== editing.original.title && { title: editing.title.trim() }),
            ...(!editing.truncated && editing.body !== editing.original.body && { body: editing.body }),
        };

        setFeedback(null);
        setEditProblem(null);

        if (Object.keys(change).length === 0) {
            setEditing(null);

            return;
        }

        const result = await attempt(actions.edit.mutateAsync(change));
        const next = settled(result, { kind: "success", text: t`Saved on ${hostLabel}.` });

        // A refusal changed nothing: the dialog stays open with its reason and the typed text. Anything else closes it.
        if (next.kind === "error" && !next.unconfirmed) {
            setEditProblem(next.text);
            // The dialog may have been closed while the write was pending: the refusal is shown on the panel too.
            setFeedback(next);

            return;
        }

        setEditing(null);
        setFeedback(next);
    };

    const submitReviewers = async () => {
        const logins = parseLogins(reviewing ?? "");
        const problem = reviewerProblem(logins);

        // The dialog stays open with the reason, so the person can correct the list without retyping it.
        if (problem !== null) {
            setReviewProblem(problem);

            return;
        }

        setReviewProblem(null);
        setFeedback(null);

        if (logins.length === 0) {
            setReviewing(null);

            return;
        }

        const result = await attempt(actions.requestReviewers.mutateAsync(logins));
        const next = settled(result, { kind: "success", text: t`Review requested.` });

        // A refusal changed nothing: the dialog stays open with its reason and the typed logins. Anything else closes it.
        if (next.kind === "error" && !next.unconfirmed) {
            setReviewProblem(next.text);
            setFeedback(next);

            return;
        }

        setReviewing(null);
        setFeedback(next);
    };

    // A second Save, reviewer request or revert must not start a second host write: each is guarded on its click.
    const saveEdit = singleFlight("edit", submitEdit);
    const sendReviewers = singleFlight("review", submitReviewers);

    const submitRevert = async () => {
        setReverting(false);
        setFeedback(null);

        const result = await attempt(actions.revert.mutateAsync());

        if ("thrown" in result) {
            setFeedback(thrownFailure(result.thrown));
        } else if (result.outcome.status === "ok") {
            // Only a link the host gave, checked again before it is shown as an address to open.
            setFeedback({
                kind: "success",
                href: safeExternalUrl(result.outcome.url) ?? undefined,
                text: t`Opened a revert pull request on ${hostLabel}.`,
            });
        } else {
            setFeedback(failure(result.outcome));
        }
    };

    const revertNow = singleFlight("revert", submitRevert);

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={titleId}>
                {t`Pull request`}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                    <Button
                        disabled={busy}
                        onClick={() => {
                            setEditing({ body, original: { body, title }, title, truncated: bodyTruncated });
                            setEditProblem(null);
                        }}
                        variant="outline"
                    >
                        {t`Edit title and description`}
                    </Button>
                )}
                {canReview && (
                    <Button
                        disabled={busy}
                        onClick={() => {
                            setReviewing("");
                            setReviewProblem(null);
                        }}
                        variant="outline"
                    >
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
                {busy && <p className="text-muted-foreground text-sm">{t`Working on ${hostLabel}…`}</p>}
                {!busy && feedback?.kind === "success" && (
                    <p className="text-sm">
                        {feedback.text}
                        {feedback.href !== undefined && (
                            <>
                                {" "}
                                <a
                                    aria-label={t`Open the revert pull request on ${hostLabel}`}
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
                                aria-describedby={titleEmpty ? `${titleId}-title-note` : undefined}
                                aria-invalid={titleEmpty || undefined}
                                id={`${titleId}-title`}
                                onChange={(event) => setEditing((current) => (current === null ? current : { ...current, title: event.target.value }))}
                                required
                                value={editing?.title ?? ""}
                            />
                            {titleEmpty && (
                                <p className="text-muted-foreground text-xs" id={`${titleId}-title-note`}>
                                    {t`A pull request needs a title. Enter one to save.`}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor={`${titleId}-body`}>{t`Description`}</Label>
                            <Textarea
                                aria-describedby={bodyLocked ? `${titleId}-body-note` : undefined}
                                disabled={bodyLocked}
                                id={`${titleId}-body`}
                                onChange={(event) => setEditing((current) => (current === null ? current : { ...current, body: event.target.value }))}
                                rows={8}
                                value={editing?.body ?? ""}
                            />
                            {bodyLocked && (
                                <p className="text-muted-foreground text-xs" id={`${titleId}-body-note`}>
                                    {t`${hostLabel} shortened this description, so it cannot be edited here. The title can still change.`}
                                </p>
                            )}
                        </div>
                    </div>
                    {editProblem !== null && (
                        <Alert className="mx-6" role="alert" variant="destructive">
                            <AlertTitle>{t`Not changed`}</AlertTitle>
                            <AlertDescription>{editProblem}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Cancel`}</DialogClose>
                        <Button disabled={(editing?.title ?? "").trim() === "" || actions.edit.isPending} onClick={saveEdit}>{t`Save`}</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>

            <Dialog
                onOpenChange={(open) => {
                    if (open) {
                        return;
                    }

                    setReviewing(null);
                    setReviewProblem(null);
                }}
                open={reviewing !== null}
            >
                <DialogPopup>
                    <DialogHeader>
                        <DialogTitle>{t`Request reviewers`}</DialogTitle>
                        <DialogDescription>{t`Enter the logins of the people to ask. Reviewers already requested stay requested.`}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1 px-6">
                        <Label htmlFor={`${titleId}-logins`}>{t`Logins`}</Label>
                        <Input
                            aria-describedby={reviewProblem === null ? undefined : `${titleId}-reviewer-problem`}
                            aria-invalid={reviewProblem === null ? undefined : true}
                            id={`${titleId}-logins`}
                            onChange={(event) => {
                                setReviewing(event.target.value);
                                setReviewProblem(null);
                            }}
                            value={reviewing ?? ""}
                        />
                    </div>
                    {reviewProblem !== null && (
                        <p className="text-destructive px-6 text-sm" id={`${titleId}-reviewer-problem`} role="alert">
                            {reviewProblem}
                        </p>
                    )}
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Cancel`}</DialogClose>
                        <Button
                            disabled={parseLogins(reviewing ?? "").length === 0 || actions.requestReviewers.isPending}
                            onClick={sendReviewers}
                        >{t`Request`}</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>

            <ConfirmDialog
                confirmLabel={t`Open revert`}
                description={t`${hostLabel} opens a new ${requestNoun} that undoes the merged change. It is a separate change for you to review and merge.`}
                loading={actions.revert.isPending}
                onConfirm={revertNow}
                onOpenChange={(open) => !open && setReverting(false)}
                open={reverting}
                title={t`Open a revert of this ${requestNoun}?`}
            />
        </section>
    );
};

export default PullRequestActionsPanel;
