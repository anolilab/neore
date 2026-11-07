"use client";

/**
 * AskUserPrompt — an `askUser` tool call: the agent paused mid-run to ask the
 * user a question (`backend/lunora/chat/tools/ask-user.ts`).
 *
 * While the call waits (`approval-requested`) the owner answers here: a
 * suggested choice sends at once, or they type their own answer — Enter sends,
 * Shift+Enter adds a line. An answer can carry up to four files, attached with
 * the composer's upload route; the server reads them for the one model call
 * that answers. Dismissing is permanent, so it is only ever the explicit
 * button: Escape just leaves the field. Either resumes the run server-side
 * (`answerAskUser`), which opens a fresh stream the thread's streaming placeholder
 * picks up. Afterwards it shows the answer read-only, with the names of the
 * files it carried.
 *
 * A call may carry up to four questions instead (`questions`): each shows its choices (checkboxes when several may be
 * picked, radios otherwise) and a note field, and one send answers the whole card (`answers`, one entry per question).
 *
 * Only the thread owner can answer: the run resumes with the owner's tools and
 * keys. Anyone else sees the question read-only.
 */

import { useLingui } from "@lingui/react/macro";
import { ASK_USER_ANSWER_MAX, ASK_USER_FILE_TYPES, ASK_USER_MAX_FILES } from "@neore/backend/ask-user-limits";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { MessageCircleQuestion, Paperclip, Send, X } from "lucide-react";
import type { FC, FormEvent, KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { AskUserQuestionDraft } from "./ask-user-choices";
import { isAskUserQuestionAnswered, normalizeAskUserChoices, normalizeAskUserQuestions } from "./ask-user-choices";
import type { AskUserAnswerEntry } from "./ask-user-questions";
import { AskUserAnswerList, AskUserQuestionFields } from "./ask-user-questions";
import { useAskUserAttachments } from "./use-ask-user-attachments";

interface AskUserInput {
    choices?: string[];
    question?: string;
    questions?: unknown;
}

type AskUserOutput =
    | { answer: string; answered: true; attachedFiles?: { filename: string; mediaType: string }[]; unreadFiles?: string[] }
    | { answered: true; answers: AskUserAnswerEntry[]; attachedFiles?: { filename: string; mediaType: string }[]; unreadFiles?: string[] }
    | { answered: false; message: string };

type Submitted = { answer: string; kind: "answer" } | { answers: AskUserAnswerEntry[]; kind: "answers" } | { kind: "dismiss" };

const EMPTY_DRAFT: AskUserQuestionDraft = { note: "", selected: [] };

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
    const [drafts, setDrafts] = useState<AskUserQuestionDraft[]>([]);
    const [submitted, setSubmitted] = useState<Submitted | null>(null);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    const { attachButtonRef, attachFiles, attachNotice, cancelSelection, fileInputRef, files, removeFile, uploading } = useAskUserAttachments();
    const { isPending, mutate } = useMutation(crpc.chat.ask_user.answerAskUser.mutationOptions());

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as AskUserInput;
    const questions = normalizeAskUserQuestions(input.questions);
    const question = questions ? "" : (input.question ?? "");
    const choices = normalizeAskUserChoices(input.choices);
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isWaiting = part.state === "approval-requested" && submitted === null;
    const canAnswer = isOwner && isWaiting && !!approvalId && !!threadId && !isPending;
    // The server refuses files in a locked chat, so the attach control is not offered there.
    const isLocked = thread?.lockedAt !== undefined && thread?.lockedAt !== null;

    const send = (reply: Submitted) => {
        if (!approvalId || !threadId) {
            return;
        }

        cancelSelection();
        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            {
                // A multi-question card answers with `answers`; dismissing sends `answer: null` for either form.
                ...(reply.kind === "answers"
                    ? {
                          answers: reply.answers.map(({ note, selected }) => {
                              return { ...(note && { note }), selected };
                          }),
                      }
                    : { answer: reply.kind === "answer" ? reply.answer : null }),
                approvalId,
                // Dismissing carries no files: the question closes without an answer.
                ...(reply.kind !== "dismiss" && files.length > 0 && { fileIds: files.map((file) => file.fileId) }),
                threadId: threadId as Id<"threads">,
            },
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

        if (answer.length > 0 && canAnswer && !uploading) {
            send({ answer, kind: "answer" });
        }
    };

    const updateDraft = (index: number, patch: Partial<AskUserQuestionDraft>) =>
        setDrafts((current) =>
            (questions ?? []).map((_, position) => {
                const base = current[position] ?? EMPTY_DRAFT;

                return position === index ? { ...base, ...patch } : base;
            }),
        );
    const allAnswered = !!questions && questions.every((_, index) => isAskUserQuestionAnswered(drafts[index] ?? EMPTY_DRAFT));

    const sendQuestions = () => {
        if (questions && allAnswered && canAnswer && !uploading) {
            send({
                answers: questions.map((entry, index) => {
                    const { note, selected } = drafts[index] ?? EMPTY_DRAFT;

                    return { question: entry.question, selected, ...(note.trim() && { note: note.trim() }) };
                }),
                kind: "answers",
            });
        }
    };

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (questions) {
            sendQuestions();
        } else {
            sendDraft();
        }
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
        answerText = "answer" in output ? output.answer : undefined;
    } else if (submitted?.kind === "answer") {
        answerText = submitted.answer;
    }

    let answerEntries: AskUserAnswerEntry[] | undefined;

    if (output?.answered && "answers" in output) {
        answerEntries = output.answers;
    } else if (submitted?.kind === "answers") {
        answerEntries = submitted.answers;
    }

    const answeredFiles = output?.answered ? (output.attachedFiles ?? []) : [];
    const unreadFiles = output?.answered ? (output.unreadFiles ?? []) : [];

    return (
        <div aria-labelledby={headingId} className="bg-muted/40 mb-4 rounded-lg border p-3 outline-none" ref={groupRef} role="group" tabIndex={-1}>
            <div className="flex items-start gap-2">
                <MessageCircleQuestion aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium whitespace-pre-wrap" id={headingId}>
                        {question || (questions ? t`The assistant has a few questions` : t`The assistant has a question`)}
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

            {answerEntries && <AskUserAnswerList entries={answerEntries} />}

            {answeredFiles.length > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                    {t`Attached:`} {answeredFiles.map((file) => file.filename).join(", ")}
                </p>
            )}

            {unreadFiles.length > 0 && <p className="text-muted-foreground mt-1 text-xs">{t`Not shown to this model: ${unreadFiles.join(", ")}`}</p>}

            {canAnswer && (
                <form className="mt-3 flex flex-col gap-2" onSubmit={onSubmit}>
                    {questions && (
                        <AskUserQuestionFields disabled={uploading} drafts={drafts} idPrefix={answerId} onChange={updateDraft} questions={questions} />
                    )}
                    {!questions && choices.length > 0 && (
                        <div aria-label={t`Suggested answers`} className="flex flex-wrap gap-2" role="group">
                            {choices.map((choice) => (
                                <Button
                                    disabled={uploading}
                                    key={choice}
                                    onClick={() => send({ answer: choice, kind: "answer" })}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    {choice}
                                </Button>
                            ))}
                        </div>
                    )}
                    {!questions && (
                        <>
                            <label className="sr-only" htmlFor={answerId}>
                                {t`Your answer`}
                            </label>
                            <Textarea
                                aria-describedby={hintId}
                                id={answerId}
                                maxLength={ASK_USER_ANSWER_MAX}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={onKeyDown}
                                placeholder={choices.length > 0 ? t`Or type your own answer…` : t`Type your answer…`}
                                rows={2}
                                size="sm"
                                value={draft}
                            />
                        </>
                    )}
                    {attachNotice && (
                        <p className="text-destructive text-xs" role="alert">
                            {attachNotice}
                        </p>
                    )}
                    {files.length > 0 && (
                        <ul aria-label={t`Attached files`} className="flex flex-wrap gap-2">
                            {files.map((file) => (
                                <li className="bg-background flex items-center gap-1 rounded-md border px-2 py-1 text-xs" key={file.fileId}>
                                    <span className="max-w-40 truncate">{file.name}</span>
                                    <button
                                        aria-label={t`Remove ${file.name}`}
                                        className="text-muted-foreground hover:text-foreground"
                                        onClick={() => removeFile(file)}
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {!questions && (
                        <p className="text-muted-foreground text-xs" id={hintId}>
                            {t`Enter to send, Shift+Enter for a new line.`}
                        </p>
                    )}
                    {questions && !allAnswered && (
                        <p className="text-muted-foreground text-xs" id={`${hintId}-answers`}>
                            {t`Answer every question with a choice or a note to send.`}
                        </p>
                    )}
                    <input
                        accept={ASK_USER_FILE_TYPES.join(",")}
                        aria-hidden="true"
                        className="hidden"
                        multiple
                        onChange={attachFiles}
                        ref={fileInputRef}
                        tabIndex={-1}
                        type="file"
                    />
                    <div className="flex flex-wrap gap-2">
                        <span className="sr-only" role="status">
                            {uploading ? t`Attaching files…` : ""}
                        </span>
                        {isLocked && <p className="text-muted-foreground text-xs">{t`Files cannot be attached in a locked chat.`}</p>}
                        <Button
                            disabled={uploading || files.length >= ASK_USER_MAX_FILES || isLocked}
                            onClick={() => fileInputRef.current?.click()}
                            ref={attachButtonRef}
                            size="sm"
                            type="button"
                            variant="ghost"
                        >
                            <Paperclip aria-hidden="true" />
                            {uploading ? t`Attaching…` : t`Attach file`}
                        </Button>
                        <Button
                            aria-describedby={questions && !allAnswered ? `${hintId}-answers` : undefined}
                            disabled={uploading || (questions ? !allAnswered : draft.trim().length === 0)}
                            size="sm"
                            type="submit"
                        >
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
