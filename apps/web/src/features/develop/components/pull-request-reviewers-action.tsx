"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useId, useState } from "react";

import type { Feedback } from "../lib/pull-request-action-feedback";
import { attempt, useActionFeedback, useSingleFlight } from "../lib/pull-request-action-feedback";
import type { PullRequestActions } from "../lib/use-pull-request-actions";

/** The login format the backend checks:a letter or digit first, then letters, digits and single hyphens or underscores. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9])){0,38}$/u;
/** The most characters a login holds, the bound LOGIN allows. */
const MAX_LOGIN = 39;
const SEPARATORS = /[\s,]+/u;
const LEADING_AT = /^@/u;

/** Splits what the person typed into logins: commas or spaces, an optional leading @. */
const parseLogins = (input: string): string[] =>
    input
        .split(SEPARATORS)
        .map((login) => login.replace(LEADING_AT, ""))
        .filter((login) => login !== "");

/**
 * Requesting reviewers by login: its button, and the dialog that holds the typed logins until the host answers. A refusal keeps
 * the dialog open with its reason; an unconfirmed answer or a request the host took closes it.
 */
const ReviewersPullRequestAction = ({
    actions,
    busy,
    hostLabel,
    maxReviewers,
    onFeedback,
    requestNoun,
}: {
    actions: PullRequestActions;
    busy: boolean;
    hostLabel: string;
    /** How many reviewers the host takes in one request; the server enforces the same bound. */
    maxReviewers: number;
    onFeedback: (feedback: Feedback | null) => void;
    requestNoun: string;
}) => {
    const { i18n, t } = useLingui();
    const titleId = useId();
    const { settled } = useActionFeedback(hostLabel);
    const singleFlight = useSingleFlight();
    const [typed, setTyped] = useState<string | null>(null);
    // A refused request keeps the dialog open with its reason, so the typed logins are still there to correct.
    const [refusal, setRefusal] = useState<string | null>(null);

    const logins = parseLogins(typed ?? "");
    const badLogin = logins.find((login) => !LOGIN.test(login));
    const tooMany = logins.length > maxReviewers;
    let problem: string | null = null;

    if (tooMany) {
        problem = t`Request at most ${i18n.number(maxReviewers)} reviewers at a time.`;
    } else if (badLogin !== undefined) {
        problem = t`"${badLogin}" is not a valid login. A login starts with a letter or digit, has at most ${i18n.number(MAX_LOGIN)} characters, and uses only letters, digits, and single hyphens or underscores.`;
    }

    const submit = async () => {
        if (problem !== null || logins.length === 0) {
            return;
        }

        onFeedback(null);
        setRefusal(null);

        const result = await attempt(actions.requestReviewers.mutateAsync(logins));
        const next = settled(result, { kind: "success", text: t`Review requested on ${hostLabel}.` });

        // A refusal changed nothing: the dialog stays open with its reason and the typed logins. Anything else closes it.
        if (next.kind === "error" && !next.unconfirmed) {
            setRefusal(next.text);
            // The dialog may have been closed while the request was pending: the refusal is shown on the panel too.
            onFeedback(next);

            return;
        }

        setTyped(null);
        onFeedback(next);
    };

    // A second click must not send a second request: each is guarded on its click.
    const send = singleFlight("reviewers", submit);

    return (
        <>
            <Button
                disabled={busy}
                onClick={() => {
                    setTyped("");
                    setRefusal(null);
                }}
                variant="outline"
            >
                {t`Request reviewers`}
            </Button>
            <Dialog onOpenChange={(open) => !open && setTyped(null)} open={typed !== null}>
                <DialogPopup>
                    <DialogHeader>
                        <DialogTitle>{t`Request reviewers`}</DialogTitle>
                        <DialogDescription>{t`Enter the logins of the people ${hostLabel} should ask to review this ${requestNoun}. Reviewers already requested stay requested.`}</DialogDescription>
                    </DialogHeader>
                    <div aria-busy={actions.requestReviewers.isPending} className="space-y-1 px-6">
                        <Label htmlFor={`${titleId}-logins`}>{t`Logins`}</Label>
                        <Input
                            aria-describedby={problem === null ? undefined : `${titleId}-logins-note`}
                            aria-invalid={problem !== null || undefined}
                            id={`${titleId}-logins`}
                            onChange={(event) => setTyped(event.target.value)}
                            readOnly={actions.requestReviewers.isPending}
                            required
                            value={typed ?? ""}
                        />
                        {problem !== null && (
                            <p className="text-destructive text-xs" id={`${titleId}-logins-note`} role="alert">
                                {problem}
                            </p>
                        )}
                    </div>
                    {refusal !== null && (
                        <Alert className="mx-6" role="alert" variant="destructive">
                            <AlertTitle>{t`Not changed`}</AlertTitle>
                            <AlertDescription>{refusal}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>{t`Cancel`}</DialogClose>
                        <Button disabled={logins.length === 0 || problem !== null || actions.requestReviewers.isPending} onClick={send}>
                            {actions.requestReviewers.isPending ? t`Requesting…` : t`Request`}
                        </Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>
        </>
    );
};

export default ReviewersPullRequestAction;
