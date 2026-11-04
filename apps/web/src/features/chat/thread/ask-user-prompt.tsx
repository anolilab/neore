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
 * Only the thread owner can answer: the run resumes with the owner's tools and
 * keys. Anyone else sees the question read-only.
 */

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { MessageCircleQuestion, Paperclip, Send, X } from "lucide-react";
import type { ChangeEvent, FC, FormEvent, KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useAction, useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";
import { downscaleOversizedImage } from "@/lib/upload/image-downscale";
import { uploadFile } from "@/lib/upload/upload-file";

import { normalizeAskUserChoices } from "./ask-user-choices";

/** Mirrors `ASK_USER_ANSWER_MAX` on the server. */
const ANSWER_MAX = 4000;

/** Mirrors `ASK_USER_MAX_FILES`, `ASK_USER_FILE_TYPES` and `ASK_USER_FILE_MAX_BYTES` on the server. */
const FILES_MAX = 4;
const FILE_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];
const FILE_MAX_BYTES = 10 * 1024 * 1024;
/** A photo may be larger than the file limit as selected: it is re-encoded before upload. This caps what is read into memory. */
const IMAGE_SELECT_MAX_BYTES = 40 * 1024 * 1024;

/** The largest a selected file may be: a photo gets the wider limit, since it is re-encoded before upload. */
const selectLimitOf = (file: File): number => (file.type.startsWith("image/") ? IMAGE_SELECT_MAX_BYTES : FILE_MAX_BYTES);
/** Mirrors `ASK_USER_FILES_TOTAL_MAX_BYTES` on the server. */
const FILES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

interface AskUserInput {
    choices?: string[];
    question?: string;
}

type AskUserOutput = { answer: string; answered: true; attachedFiles?: { filename: string; mediaType: string }[] } | { answered: false; message: string };

type Submitted = { answer: string; kind: "answer" } | { kind: "dismiss" };

interface AttachedFile {
    fileId: string;
    name: string;
    size: number;
}

const AskUserPrompt: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const finalizeUpload = useAction(api.file.finalizeChatUpload);
    const headingId = useId();
    const answerId = useId();
    const hintId = useId();
    const [draft, setDraft] = useState("");
    const [submitted, setSubmitted] = useState<Submitted | null>(null);
    const [files, setFiles] = useState<AttachedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Stops the selection in progress when the question is answered or dismissed, so no later file is uploaded or finalized.
    const uploadAbort = useRef<AbortController | null>(null);
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

        uploadAbort.current?.abort();
        setSubmitted(reply);
        groupRef.current?.focus();
        mutate(
            {
                answer: reply.kind === "answer" ? reply.answer : null,
                approvalId,
                // Dismissing carries no files: the question closes without an answer.
                ...(reply.kind === "answer" && files.length > 0 && { fileIds: files.map((file) => file.fileId) }),
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

    const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
        const fileInput = event.target;
        const picked = [...(fileInput.files ?? [])];

        fileInput.value = "";

        const room = FILES_MAX - files.length;
        const typed = picked.filter((file) => FILE_TYPES.includes(file.type) && file.size <= selectLimitOf(file));
        const accepted: File[] = [];
        let total = files.reduce((sum, file) => sum + file.size, 0);

        for (const file of typed) {
            if (accepted.length >= room) {
                break;
            }

            // A file that does not fit the budget is skipped; a smaller one after it may still fit.
            if (total + file.size <= FILES_TOTAL_MAX_BYTES) {
                accepted.push(file);
                total += file.size;
            }
        }

        if (accepted.length < picked.length) {
            showError(t`Only PNG, JPEG, WEBP or GIF images, and PDFs up to 10 MB, 20 MB in all and four at most.`);
        }

        if (accepted.length === 0) {
            return;
        }

        setUploading(true);

        const controller = new AbortController();

        uploadAbort.current = controller;

        // One file's failure does not stop the others: each is attached or named as failed.
        const failed: string[] = [];

        try {
            for (const file of accepted) {
                if (controller.signal.aborted) {
                    break;
                }

                try {
                    // Photos are re-encoded below the provider's per-image limit, as the composer does; PDFs go as they are.
                    const prepared = file.type.startsWith("image/") ? await downscaleOversizedImage(file) : file;

                    // A photo that re-encoding could not bring under the file limit is named as failed, like any other.
                    if (prepared.size > FILE_MAX_BYTES) {
                        failed.push(file.name);

                        continue;
                    }

                    const uploadId = await uploadFile(prepared, { contentType: prepared.type, signal: controller.signal });

                    if (controller.signal.aborted) {
                        break;
                    }

                    const { fileId } = await finalizeUpload({ filename: file.name, uploadId });

                    // The server dedupes uploads by content, so the same photo can come back with an id already attached.
                    setFiles((current) =>
                        current.some((item) => item.fileId === fileId) ? current : [...current, { fileId, name: file.name, size: prepared.size }],
                    );
                } catch {
                    // An upload cut short by a dismissal is not a failure to report.
                    if (!controller.signal.aborted) {
                        failed.push(file.name);
                    }
                }
            }
        } finally {
            setUploading(false);
        }

        if (failed.length > 0) {
            showError(t`Could not attach ${failed.join(", ")}. The other files were attached; try those again.`);
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

    const answeredFiles = output?.answered ? (output.attachedFiles ?? []) : [];

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

            {answeredFiles.length > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                    {t`Attached:`} {answeredFiles.map((file) => file.filename).join(", ")}
                </p>
            )}

            {canAnswer && (
                <form className="mt-3 flex flex-col gap-2" onSubmit={onSubmit}>
                    {choices.length > 0 && (
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
                    {files.length > 0 && (
                        <ul aria-label={t`Attached files`} className="flex flex-wrap gap-2">
                            {files.map((file) => (
                                <li className="bg-background flex items-center gap-1 rounded-md border px-2 py-1 text-xs" key={file.fileId}>
                                    <span className="max-w-40 truncate">{file.name}</span>
                                    <button
                                        aria-label={t`Remove ${file.name}`}
                                        className="text-muted-foreground hover:text-foreground"
                                        onClick={() => setFiles((current) => current.filter((item) => item.fileId !== file.fileId))}
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="text-muted-foreground text-xs" id={hintId}>
                        {t`Enter to send, Shift+Enter for a new line.`}
                    </p>
                    <input
                        accept={FILE_TYPES.join(",")}
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
                        <Button
                            disabled={uploading || files.length >= FILES_MAX}
                            onClick={() => fileInputRef.current?.click()}
                            size="sm"
                            type="button"
                            variant="ghost"
                        >
                            <Paperclip aria-hidden="true" />
                            {uploading ? t`Attaching…` : t`Attach file`}
                        </Button>
                        <Button disabled={uploading || draft.trim().length === 0} size="sm" type="submit">
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
