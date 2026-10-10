"use client";

/**
 * AskUserPrompt — an `askUser` tool call: the agent paused mid-run to ask the
 * user a question (`backend/lunora/chat/tools/ask-user.ts`).
 *
 * While the call waits (`approval-requested`) the owner answers here: a
 * suggested choice sends at once, or they type their own answer — Enter sends,
 * Shift+Enter adds a line. Dismissing is permanent, so it is only ever the
 * explicit button: Escape just leaves the field. Either resumes the run
 * server-side (`answerAskUser`), which opens a fresh stream the thread's
 * streaming placeholder picks up. Afterwards it shows the answer read-only.
 *
 * Only the thread owner can answer: the run resumes with the owner's tools and
 * keys. Anyone else sees the question read-only.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { MessageCircleQuestion, Send, X } from "lucide-react";
import type { FC, FormEvent, KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import { normalizeAskUserChoices } from "./ask-user-choices";

/** Mirrors `ASK_USER_ANSWER_MAX` on the server. */
const ANSWER_MAX = 4000;

interface AskUserInput {
    choices?: string[];
    question?: string;
}

type AskUserOutput = { answer: string; answered: true } | { answered: false; message: string };

type Submitted = { answer: string; kind: "answer" } | { kind: "dismiss" };

const AskUserPrompt: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const headingId = useId();
    const answerId = useId();
    const hintId = useId();
    const [draft, setDraft] = useState("");
    const [submitted, setSubmitted] = useState<Submitted | null>(null);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    const { isPending, mutate } = useMutation(crpc.chat.ask_user.answerAskUser.mutationOptions());

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as AskUserInput;
    const question = input.question ?? "";
    const choices = normalizeAskUserChoices(input.choices);
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isWaiting = part.state === "approval-requested" && submitted === null;
    const canAnswer = isOwner && isWaiting && !!approvalId && !!threadId && !isPending;

    const send = (reply: Submitted) => {
        if (!approvalId || !threadId) {
            return;
        }

        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            { answer: reply.kind === "answer" ? reply.answer : null, approvalId, threadId: threadId as Id<"threads"> },
            {
                onError: (error) => {
                    setSubmitted(null);
                    showError(error instanceof Error ? error : t`Could not send your answer. Please try again.`);
                },
            },
        );
    };

    const sendDraft = () => {
        const answer = draft.trim();

        if (answer.length > 0 && canAnswer) {
            send({ answer, kind: "answer" });
        }
    };

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        sendDraft();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Escape") {
            // Leaves the field only; dismissing is the explicit button's job.
            event.currentTarget.blur();
        } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            sendDraft();
        }
    };

    const output = part.state === "output-available" ? (part.output as AskUserOutput | undefined) : undefined;
    let statusText: string;

    if (output?.answered) {
        statusText = t`Answered`;
    } else if (part.state === "output-denied" || submitted?.kind === "dismiss") {
        statusText = t`Dismissed — continuing without an answer`;
    } else if (submitted || part.state === "approval-responded" || part.state === "output-available") {
        statusText = t`Answer sent — continuing`;
    } else if (part.state === "input-streaming" || part.state === "input-available") {
        statusText = t`Preparing a question…`;
    } else {
        statusText = isOwner ? t`Waiting for your answer` : t`Waiting for the owner to answer`;
    }

    let answerText: string | undefined;

    if (output?.answered) {
        answerText = output.answer;
    } else if (submitted?.kind === "answer") {
        answerText = submitted.answer;
    }

    return (
        <div aria-labelledby={headingId} className="bg-muted/40 mb-4 rounded-lg border p-3 outline-none" ref={groupRef} role="group" tabIndex={-1}>
            <div className="flex items-start gap-2">
                <MessageCircleQuestion aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium whitespace-pre-wrap" id={headingId}>
                        {question || t`The assistant has a question`}
                    </p>
                    <p aria-live="polite" className="text-muted-foreground text-xs" role="status">
                        {statusText}
                    </p>
                </div>
            </div>

            {answerText !== undefined && (
                <p className="bg-background mt-2 rounded-md border px-3 py-2 text-sm whitespace-pre-wrap">
                    <span className="sr-only">{t`Your answer:`} </span>
                    {answerText}
                </p>
            )}

            {canAnswer && (
                <form className="mt-3 flex flex-col gap-2" onSubmit={onSubmit}>
                    {choices.length > 0 && (
                        <div aria-label={t`Suggested answers`} className="flex flex-wrap gap-2" role="group">
                            {choices.map((choice) => (
                                <Button key={choice} onClick={() => send({ answer: choice, kind: "answer" })} size="sm" type="button" variant="outline">
                                    {choice}
                                </Button>
                            ))}
                        </div>
                    )}
                    <label className="sr-only" htmlFor={answerId}>
                        {t`Your answer`}
                    </label>
                    <Textarea
                        aria-describedby={hintId}
                        id={answerId}
                        maxLength={ANSWER_MAX}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={choices.length > 0 ? t`Or type your own answer…` : t`Type your answer…`}
                        rows={2}
                        size="sm"
                        value={draft}
                    />
                    <p className="text-muted-foreground text-xs" id={hintId}>
                        {t`Enter to send, Shift+Enter for a new line.`}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={draft.trim().length === 0} size="sm" type="submit">
                            <Send aria-hidden="true" />
                            {t`Send answer`}
                        </Button>
                        <Button onClick={() => send({ kind: "dismiss" })} size="sm" type="button" variant="ghost">
                            <X aria-hidden="true" />
                            {t`Dismiss`}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
};

export default AskUserPrompt;
