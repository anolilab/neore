"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useState } from "react";

import type { Feedback } from "../lib/pull-request-action-feedback";
import { attempt, useActionFeedback, useSingleFlight } from "../lib/pull-request-action-feedback";
import type { PullRequestActions } from "../lib/use-pull-request-actions";

/** The most characters a host title holds; the backend refuses a longer one with the same bound. */
const MAX_TITLE = 256;
/** The most characters a description holds, the bound the backend's edit input checks. */
const MAX_BODY = 65_536;

/**
 * The title and description edit: its button, and the dialog that holds the typed text until the host answers. A refusal keeps
 * the dialog open with its reason; an unconfirmed answer or a saved edit closes it.
 */
const EditPullRequestAction = ({
    actions,
    body,
    bodyTruncated,
    busy,
    hostLabel,
    onFeedback,
    requestNoun,
    title,
}: {
    actions: PullRequestActions;
    body: string;
    /** The host cut the description short: saving it would write the cut text back, so it stays as it is. */
    bodyTruncated: boolean;
    busy: boolean;
    hostLabel: string;
    onFeedback: (feedback: Feedback | null) => void;
    requestNoun: string;
    title: string;
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const { settled } = useActionFeedback(hostLabel);
    const singleFlight = useSingleFlight();
    // `original` is the page as it was when the dialog opened: a later refetch must not turn an untouched field into a write.
    // `truncated` is captured when the dialog opens: a refetch during the edit must not change what Save writes.
    const [editing, setEditing] = useState<{ body: string; original: { body: string; title: string }; title: string; truncated: boolean } | null>(null);
    // A refused save keeps the dialog open with its reason, so the typed text is still there to correct.
    const [editProblem, setEditProblem] = useState<string | null>(null);

    const titleEmpty = (editing?.title ?? "").trim() === "";
    // The host's limit on a title, the same bound the server enforces: a longer one is said here, before the write.
    const titleTooLong = (editing?.title ?? "").trim().length > MAX_TITLE;
    const titleProblem = titleEmpty || titleTooLong;
    const bodyLocked = editing?.truncated === true;
    const bodyTooLong = !bodyLocked && (editing?.body ?? "").length > MAX_BODY;

    const submitEdit = async () => {
        if (editing === null) {
            return;
        }

        // The title is compared as typed: an untouched title with surrounding spaces must not be sent trimmed in a description-only save.
        const change = {
            ...(editing.title !== editing.original.title && { title: editing.title.trim() }),
            ...(!editing.truncated && editing.body !== editing.original.body && { body: editing.body }),
        };

        onFeedback(null);
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
            onFeedback(next);

            return;
        }

        setEditing(null);
        onFeedback(next);
    };

    // A second Save must not send a second edit over a newer change: each is guarded on its click.
    const saveEdit = singleFlight("edit", submitEdit);

    return (
        <>
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
                                aria-describedby={titleProblem ? `${titleId}-title-note` : undefined}
                                aria-invalid={titleProblem || undefined}
                                id={`${titleId}-title`}
                                onChange={(event) => setEditing((current) => (current === null ? current : { ...current, title: event.target.value }))}
                                required
                                value={editing?.title ?? ""}
                            />
                            {titleProblem && (
                                <p className="text-muted-foreground text-xs" id={`${titleId}-title-note`}>
                                    {titleTooLong
                                        ? t`A pull request title is at most ${MAX_TITLE} characters.`
                                        : t`A pull request needs a title. Enter one to save.`}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor={`${titleId}-body`}>{t`Description`}</Label>
                            <Textarea
                                aria-describedby={bodyLocked || bodyTooLong ? `${titleId}-body-note` : undefined}
                                aria-invalid={bodyTooLong || undefined}
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
                            {bodyTooLong && (
                                <p className="text-muted-foreground text-xs" id={`${titleId}-body-note`}>
                                    {t`A description is at most ${MAX_BODY} characters.`}
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
                        <Button disabled={titleProblem || bodyTooLong || actions.edit.isPending} onClick={saveEdit}>{t`Save`}</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>
        </>
    );
};

export default EditPullRequestAction;
