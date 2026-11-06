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
import { useEffect, useId, useRef, useState } from "react";

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
/** Mirrors `ASK_USER_FILES_TOTAL_MAX_BYTES` on the server. */
const FILES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/** A photo may be larger than the file limit as selected: it is re-encoded before upload. This caps what is read into memory. */
const IMAGE_SELECT_MAX_BYTES = 40 * 1024 * 1024;
/** Mirrors `ASK_USER_IMAGE_MAX_BYTES` on the server: the largest image a provider takes as base64 in one call. */
const IMAGE_MAX_BYTES = 3_932_160;

/** The extension of a file name, with its dot. */
const EXTENSION = /\.[^.]*$/;

/** The name a re-encoded photo is saved under: its base name with the extension of the type it was encoded as. */
const renamedFor = (name: string, type: string): string => {
    const base = name.replace(EXTENSION, "");
    const extension = type === "image/jpeg" ? "jpg" : (type.split("/", 2)[1] ?? "");

    return extension ? `${base}.${extension}` : name;
};

/** The largest a selected file may be: a photo gets the wider limit, since it is re-encoded before upload. */
const selectLimitOf = (file: File): number => (file.type.startsWith("image/") ? IMAGE_SELECT_MAX_BYTES : FILE_MAX_BYTES);

interface AskUserInput {
    choices?: string[];
    question?: string;
}

type AskUserOutput =
    | { answer: string; answered: true; attachedFiles?: { filename: string; mediaType: string }[]; unreadFiles?: string[] }
    | { answered: false; message: string };

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
    // The last attach attempt's failures, kept in the card so they stay visible after the toast has gone.
    const [attachNotice, setAttachNotice] = useState<string | null>(null);
    // Focus lands here after a send: the form (and the focused control) goes away.
    const groupRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attachButtonRef = useRef<HTMLButtonElement>(null);
    // Bytes attached so far: a chip removed mid-selection gives its bytes back at once, so the next file is checked against what is left.
    const attachedBytes = useRef(0);
    // The ids of the chips attached now: a photo the server dedupes onto one of them adds no bytes.
    const attachedIds = useRef(new Set<string>());
    // Stops the selection in progress when the question is answered or dismissed, so no later file is uploaded or finalized.
    const uploadAbort = useRef<AbortController | null>(null);

    // A card that goes away (the thread changes, the message is removed) stops its selection in progress.
    useEffect(() => () => uploadAbort.current?.abort(), []);
    const { isPending, mutate } = useMutation(crpc.chat.ask_user.answerAskUser.mutationOptions());

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as AskUserInput;
    const question = input.question ?? "";
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
        setAttachNotice(null);

        const fileInput = event.target;
        const picked = [...(fileInput.files ?? [])];

        fileInput.value = "";

        const room = FILES_MAX - files.length;
        const typed = picked.filter((file) => FILE_TYPES.includes(file.type) && file.size <= selectLimitOf(file));
        const accepted = typed.slice(0, Math.max(room, 0));

        // The budget counts what is uploaded, so it is checked per file after re-encoding, below.
        attachedBytes.current = files.reduce((sum, file) => sum + file.size, 0);
        attachedIds.current = new Set(files.map((file) => file.fileId));

        if (accepted.length < picked.length) {
            showError(t`Only PNG, JPEG, WEBP or GIF images, and PDFs up to 10 MB, 20 MB in all and four at most.`);
        }

        if (accepted.length === 0) {
            return;
        }

        setUploading(true);

        const controller = new AbortController();

        uploadAbort.current = controller;

        // One file's failure does not stop the others: each is attached or named as failed. A file over a size limit is
        // named apart, since choosing it again cannot succeed.
        const failed: string[] = [];
        const tooLarge: string[] = [];
        let attachedThisRun = 0;

        try {
            for (const file of accepted) {
                if (controller.signal.aborted) {
                    break;
                }

                try {
                    // Photos are re-encoded below the provider's per-image limit, as the composer does; PDFs go as they are.
                    const prepared = file.type.startsWith("image/") ? await downscaleOversizedImage(file) : file;

                    // Some images cannot be re-encoded, so an image is checked against the provider's limit as it stands.
                    const limit = file.type.startsWith("image/") ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;

                    if (prepared.size > limit) {
                        tooLarge.push(file.name);

                        continue;
                    }

                    if (attachedBytes.current + prepared.size > FILES_TOTAL_MAX_BYTES) {
                        failed.push(file.name);

                        continue;
                    }

                    const uploadId = await uploadFile(prepared, { contentType: prepared.type, signal: controller.signal });

                    if (controller.signal.aborted) {
                        break;
                    }

                    // A re-encoded photo has the new type's extension, so the saved name matches the bytes uploaded.
                    const filename = prepared === file ? file.name : renamedFor(file.name, prepared.type);
                    const { fileId } = await finalizeUpload({ filename, uploadId });

                    // Dismissed while the upload was finalizing: the answer is gone, so this file must not reach the chips.
                    if (controller.signal.aborted) {
                        break;
                    }

                    // The server dedupes uploads by content: a photo that comes back with an id already attached adds nothing.
                    if (attachedIds.current.has(fileId)) {
                        continue;
                    }

                    // Counted only once the upload is in, so a failed one does not use up the budget.
                    attachedIds.current.add(fileId);
                    attachedBytes.current += prepared.size;
                    attachedThisRun += 1;
                    setFiles((current) => [...current, { fileId, name: filename, size: prepared.size }]);
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

        if (tooLarge.length > 0 || failed.length > 0) {
            const notices: string[] = [];

            if (tooLarge.length > 0) {
                notices.push(t`Too large to attach: ${tooLarge.join(", ")}. Reduce the file and attach it again.`);
            }

            if (failed.length > 0) {
                notices.push(
                    attachedThisRun > 0
                        ? t`Could not attach ${failed.join(", ")}. The other files were attached; try those again.`
                        : t`Could not attach ${failed.join(", ")}. Try those again.`,
                );
            }

            const message = notices.join(" ");

            setAttachNotice(message);
            showError(message);
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
    const unreadFiles = output?.answered ? (output.unreadFiles ?? []) : [];

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

            {unreadFiles.length > 0 && <p className="text-muted-foreground mt-1 text-xs">{t`Not shown to this model: ${unreadFiles.join(", ")}`}</p>}

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
                                        onClick={() => {
                                            attachedBytes.current -= file.size;
                                            attachedIds.current.delete(file.fileId);
                                            setFiles((current) => current.filter((item) => item.fileId !== file.fileId));
                                            // Focus stays in the card: the remove button goes, so the attach button takes it.
                                            attachButtonRef.current?.focus();
                                        }}
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
                        {isLocked && <p className="text-muted-foreground text-xs">{t`Files cannot be attached in a locked chat.`}</p>}
                        <Button
                            disabled={uploading || files.length >= FILES_MAX || isLocked}
                            onClick={() => fileInputRef.current?.click()}
                            ref={attachButtonRef}
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
