"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useId, useState } from "react";

import type { Feedback } from "../lib/pull-request-action-feedback";
import { attempt, useActionFeedback, useSingleFlight } from "../lib/pull-request-action-feedback";
import type { PullRequestActions } from "../lib/use-pull-request-actions";

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
 * Requesting reviewers by login: its button, and the dialog that holds the typed logins until the host answers. A refusal keeps
 * the dialog open with its reason; an unconfirmed answer or a request the host took closes it.
 */
const ReviewersPullRequestAction = ({
    actions,
    busy,
    hostLabel,
    onFeedback,
}: {
    actions: PullRequestActions;
    busy: boolean;
    hostLabel: string;
    onFeedback: (feedback: Feedback | null) => void;
}) => {
    const { t } = useLingui();
    const titleId = useId();
    const { settled } = useActionFeedback(hostLabel);
    const singleFlight = useSingleFlight();
    const [reviewing, setReviewing] = useState<string | null>(null);
    const [reviewProblem, setReviewProblem] = useState<string | null>(null);

    const reviewerProblem = (logins: string[]): string | null => {
        if (logins.length > MAX_REVIEWERS) {
            return t`Request at most ${MAX_REVIEWERS} reviewers at a time.`;
        }

        return logins.every((login) => LOGIN.test(login))
            ? null
            : t`Logins use letters, digits, single hyphens or underscores. A hyphen cannot start or end a login, or come twice in a row.`;
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
        onFeedback(null);

        if (logins.length === 0) {
            setReviewing(null);

            return;
        }

        const result = await attempt(actions.requestReviewers.mutateAsync(logins));
        const next = settled(result, { kind: "success", text: t`Review requested.` });

        // A refusal changed nothing: the dialog stays open with its reason and the typed logins. Anything else closes it.
        if (next.kind === "error" && !next.unconfirmed) {
            setReviewProblem(next.text);
            onFeedback(next);

            return;
        }

        setReviewing(null);
        onFeedback(next);
    };

    // A second request must not start a second host write: each is guarded on its click.
    const sendReviewers = singleFlight("review", submitReviewers);

    return (
        <>
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
        </>
    );
};

export default ReviewersPullRequestAction;
