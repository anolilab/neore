"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { hostCapabilityOf, isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { ReviewVerdict } from "@neore/backend/source-control/types";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useRef, useState } from "react";

import { safeExternalUrl } from "../lib/format";
import { VERDICT_CAPABILITIES } from "../lib/review";
import type { PullRequestAddress } from "../lib/use-develop";
import { useDraftMutations, useReviewActions, useReviewDraft } from "../lib/use-review";
import { useReviewMessages } from "../lib/use-review-messages";

type Feedback = { kind: "error"; text: string } | { kind: "success"; url: string | undefined } | { kind: "info"; text: string };

/**
 * The review being written: the verdict, a summary and the comments added on the diff. It lives on
 * the server, so it is here after a reload and on another device. Submitting posts it as ONE
 * review; the draft is kept unless the host confirmed it. Every control follows the capability report.
 */
const ReviewPanel = ({
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
    const messages = useReviewMessages(hostLabel);
    const summaryId = useId();
    const draft = useReviewDraft(address);
    const mutations = useDraftMutations();
    const actions = useReviewActions(address);
    // What is being typed, or `null` while the box just shows the stored summary (and so follows another device's edits).
    const [typed, setTyped] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    // Set before the summary is saved, so a second click cannot start another submit while the first is still saving.
    const [submitting, setSubmitting] = useState(false);
    const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
    const pendingSaves = useRef(0);
    const chosenVerdict = useRef<ReviewVerdict | null | undefined>(undefined);
    const stored = draft.data;
    const verdicts = (Object.keys(VERDICT_CAPABILITIES) as ReviewVerdict[]).filter((verdict) =>
        isHostCapabilityAvailable(capabilities, VERDICT_CAPABILITIES[verdict]),
    );

    if (verdicts.length === 0) {
        return null;
    }

    const locked = stored?.submitting === true || submitting || actions.submit.isPending;
    const batched = hostCapabilityOf(capabilities, "review.batchedSubmit");
    const emulated = !batched.supported || batched.degradation !== "none";
    const verdictLabels: Record<ReviewVerdict, string> = { approve: t`Approve`, comment: t`Comment`, request_changes: t`Request changes` };

    const dirty = typed !== null;
    const summary = typed ?? stored?.body ?? "";

    /**
     * Stores the summary and, when given, the verdict. Saves run one after another, and a save that names no verdict
     * carries the one chosen last, so a blur save cannot put back the verdict a click just replaced.
     * Resolves to whether they are stored now.
     */
    const saveReview = async (next: { body: string; verdict?: ReviewVerdict | null }): Promise<boolean> => {
        if (next.verdict !== undefined) {
            chosenVerdict.current = next.verdict;
        }

        const verdict = next.verdict ?? chosenVerdict.current ?? stored?.verdict ?? null;
        const run = async (): Promise<boolean> => {
            const outcome = await mutations.setReview.mutateAsync({ ...address, body: next.body, commitId: headSha, verdict });

            if (outcome.status === "ok") {
                // Text typed while this save ran stays, and is saved by its own blur.
                setTyped((current) => (current === next.body ? null : current));
                setFeedback(null);

                return true;
            }

            setFeedback({ kind: "error", text: messages.edit(outcome.status) });

            return false;
        };

        pendingSaves.current += 1;

        const saved = saveQueue.current.then(run);

        saveQueue.current = saved.catch(() => false);

        try {
            return await saved;
        } finally {
            pendingSaves.current -= 1;

            if (pendingSaves.current === 0) {
                chosenVerdict.current = undefined;
            }
        }
    };

    const post = async () => {
        try {
            const outcome = await actions.submit.mutateAsync();

            switch (outcome.status) {
                case "in_progress": {
                    setFeedback({ kind: "info", text: t`This review is already being submitted, maybe from another device.` });

                    break;
                }
                case "needs_text": {
                    setFeedback({ kind: "error", text: t`Write a summary, or add a comment, before you submit this review.` });

                    break;
                }
                case "needs_verdict": {
                    setFeedback({ kind: "error", text: t`Choose how you review this before you submit it.` });

                    break;
                }
                case "no_draft": {
                    setFeedback({ kind: "info", text: t`There is nothing to submit.` });

                    break;
                }
                case "ok": {
                    setFeedback({ kind: "success", url: safeExternalUrl(outcome.reviewUrl) });

                    break;
                }
                case "unconfirmed": {
                    // A review the host kept as pending blocks another one until it is submitted or deleted there.
                    setFeedback({
                        kind: "error",
                        text: `${messages.write(outcome)} ${t`If it kept the review as pending, submit or delete it there first.`} ${t`Your review is kept.`}`,
                    });

                    break;
                }
                default: {
                    setFeedback({ kind: "error", text: `${messages.write(outcome)} ${t`Your review is kept.`}` });
                }
            }
        } catch {
            // The action may have run to the host before the answer was lost: say so rather than invite a second review.
            setFeedback({ kind: "error", text: t`Could not confirm that the review was submitted. Check on ${hostLabel} before you try again. Your review is kept here.` });
        }
    };

    const submit = async () => {
        setSubmitting(true);
        setFeedback(null);

        try {
            // The summary typed last goes with the review even if the box never lost focus; if it is not stored, nothing is posted.
            if (dirty && !(await saveReview({ body: summary }))) {
                return;
            }

            await post();
        } catch {
            setFeedback({ kind: "error", text: t`Could not save the summary, so nothing was submitted. Try again.` });
        } finally {
            setSubmitting(false);
        }
    };

    const commentCount = stored?.comments.length ?? 0;

    return (
        <section aria-labelledby={`${summaryId}-title`} className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold" id={`${summaryId}-title`}>
                {t`Your review`}
            </h3>
            <p className="text-muted-foreground text-xs">
                {commentCount > 0 ? (
                    <Plural one="# comment is waiting to be submitted" other="# comments are waiting to be submitted" value={commentCount} />
                ) : (
                    t`Add comments on a line of the diff, then submit.`
                )}
            </p>
            {commentCount > 0 && stored && stored.commitId !== headSha && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                    {t`Your comments were written on an earlier version of this change. They are posted against that version, and the lines shown below may have moved.`}
                </p>
            )}
            <RadioGroup
                aria-label={t`How you review this`}
                className="flex flex-wrap gap-4"
                disabled={locked}
                onValueChange={async (value) => await saveReview({ body: summary, verdict: value as ReviewVerdict })}
                value={stored?.verdict ?? ""}
            >
                {verdicts.map((verdict) => (
                    <div className="flex items-center gap-2 text-sm" key={verdict}>
                        <RadioGroupItem id={`${summaryId}-${verdict}`} value={verdict} />
                        <label htmlFor={`${summaryId}-${verdict}`}>{verdictLabels[verdict]}</label>
                    </div>
                ))}
            </RadioGroup>
            <div className="space-y-1">
                <label className="text-sm" htmlFor={summaryId}>
                    {t`Summary`}
                </label>
                <Textarea
                    disabled={locked}
                    id={summaryId}
                    onBlur={async () => {
                        if (dirty) {
                            await saveReview({ body: summary });
                        }
                    }}
                    onChange={(event) => {
                        setTyped(event.target.value);
                    }}
                    value={summary}
                />
            </div>
            {emulated && (
                <p className="text-muted-foreground text-xs">{t`${hostLabel} has no batched review: your comments are posted one after another when you submit.`}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <Button disabled={locked || ((stored === null || stored === undefined) && !dirty)} onClick={submit}>
                    {actions.submit.isPending ? t`Submitting…` : t`Submit review`}
                </Button>
                {confirmingDiscard ? (
                    <>
                        <Button
                            disabled={locked}
                            onClick={async () => {
                                const outcome = await mutations.discard.mutateAsync(address);

                                if (outcome.status !== "ok") {
                                    setFeedback({ kind: "error", text: messages.edit(outcome.status) });

                                    return;
                                }

                                setConfirmingDiscard(false);
                                setTyped(null);
                                setFeedback(null);
                            }}
                            variant="destructive"
                        >
                            {t`Discard the review`}
                        </Button>
                        <Button onClick={() => setConfirmingDiscard(false)} variant="ghost">
                            {t`Keep it`}
                        </Button>
                    </>
                ) : (
                    stored && (
                        <Button disabled={locked} onClick={() => setConfirmingDiscard(true)} variant="ghost">
                            {t`Discard`}
                        </Button>
                    )
                )}
            </div>
            <div aria-live="polite" role="status">
                {feedback?.kind === "success" && (
                    <Alert>
                        <AlertTitle>{t`Review submitted`}</AlertTitle>
                        <AlertDescription>
                            {t`It is on ${hostLabel} now.`}{" "}
                            {feedback.url && (
                                <a className="text-primary font-medium underline" href={feedback.url} rel="noopener noreferrer" target="_blank">
                                    {t`View it`}
                                </a>
                            )}
                        </AlertDescription>
                    </Alert>
                )}
                {feedback?.kind === "info" && <p className="text-muted-foreground text-sm">{feedback.text}</p>}
            </div>
            {feedback?.kind === "error" && (
                <Alert role="alert" variant="destructive">
                    <AlertTitle>{t`Not submitted`}</AlertTitle>
                    <AlertDescription>{feedback.text}</AlertDescription>
                </Alert>
            )}
        </section>
    );
};

export default ReviewPanel;
