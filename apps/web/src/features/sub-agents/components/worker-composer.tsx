"use client";

/**
 * The composer of a worker's own thread. A worker takes a turn only through `dispatchToWorker`, so
 * this replaces the chat composer there: one message starts one run, and the run's reply lands in
 * the thread as it does for the lead's messages. The `clientId` is kept until the send is answered,
 * so a retry of a send that may have landed returns the same run instead of starting a second.
 */

import { useLingui } from "@lingui/react/macro";
import { stripHiddenText } from "@neore/ai/utils";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { SendIcon } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import BrowserLiveView from "@/features/chat/browser-live-view/browser-live-view";
import { peekWorkerDraft, saveWorkerDraft } from "@/features/chat/split/composer-drafts";
import { useComposerPrefill } from "@/features/chat/thread/composer-prefill";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

interface WorkerComposerProps {
    archived: boolean;
    busy: boolean;
    className?: string;
    /** How a message sent while a run is going is handled; only `queue` is offered, since only it is built. */
    followUp: "none" | "queue" | "steer" | "steer-restart";
    workerId: string;
}

const WorkerComposer: FC<WorkerComposerProps> = ({ archived, busy, className, followUp, workerId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    // The text is kept per worker: its composer unmounts when focus moves to another pane, and comes back with the text.
    const [text, setText] = useState(() => peekWorkerDraft(workerId) ?? "");
    const draft = useRef(text);
    const clientId = useRef<string | undefined>(undefined);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // The fix prompts added while a send runs (`null` when none runs): they were not sent, so they outlast it.
    const prefillsDuringSend = useRef<string[] | null>(null);
    const send = useMutation(crpc.sub_agents.functions.dispatchToWorker.mutationOptions());

    useEffect(
        () => () => {
            saveWorkerDraft(workerId, draft.current);
        },
        [workerId],
    );

    // A fix prompt from the header's pull request chip (`composer-prefill.ts`): added after the draft, never sent. A
    // worker's thread id is its worker id.
    useComposerPrefill(workerId, (prefill) => {
        // Cleaned of hidden characters: the prompt quotes host text (review bodies) that the worker would otherwise read.
        const { text: clean } = stripHiddenText(prefill);

        if (!draft.current.includes(clean)) {
            const next = draft.current.trim() === "" ? clean : `${draft.current.trimEnd()}\n${clean}`;

            prefillsDuringSend.current?.push(clean);
            clientId.current = undefined;
            draft.current = next;
            setText(next);
        }

        textareaRef.current?.focus();
    });

    let notice: string | undefined;

    if (archived) {
        notice = t`This worker is archived. Restore it to message it again.`;
    } else if (busy) {
        notice = followUp === "queue" ? t`The worker is busy. Your message runs after the earlier ones.` : t`The worker is working on an earlier message.`;
    }

    const message = text.trim();
    const canSend = message.length > 0 && !archived && (!busy || followUp === "queue") && !send.isPending;

    const submit = () => {
        if (!canSend) {
            return;
        }

        clientId.current ??= crypto.randomUUID();
        prefillsDuringSend.current = [];

        send.mutate(
            { clientId: clientId.current, message, workerId: workerId as Id<"threads"> },
            {
                onError: (error: unknown) => {
                    prefillsDuringSend.current = null;
                    showError(error instanceof Error ? error : t`Could not send the message.`);
                },
                onSuccess: () => {
                    // What joined the draft while the send ran (a fix prompt from the header) stays; the sent text goes.
                    // A draft edited during the send is the sent message, so it goes rather than wait to go out twice; the
                    // fix prompts that arrived meanwhile were not sent, so they stay, unless the person deleted them.
                    const typed = draft.current.trimStart();
                    const prefills = prefillsDuringSend.current ?? [];
                    const rest = typed.startsWith(message)
                        ? typed.slice(message.length).trimStart()
                        : prefills.filter((prefill) => typed.includes(prefill)).join("\n");

                    prefillsDuringSend.current = null;

                    clientId.current = undefined;
                    draft.current = rest;
                    setText(rest);
                },
            },
        );
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        submit();
    };

    return (
        <div className={className}>
            {/* A cloud worker drives the browser too: watch it live, read-only, as from the chat composer. */}
            <BrowserLiveView threadId={workerId as Id<"threads">} />
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                {notice && (
                    <p className="text-muted-foreground mb-2 text-xs" role="status">
                        {notice}
                    </p>
                )}
                <div className="flex items-end gap-2">
                    <Textarea
                        aria-label={t`Message the worker`}
                        className="min-h-[44px] flex-1"
                        // The box is the composer's focus area for F6, as the cloud composer's editor is (`composer-tiptap/editor-attributes.ts`).
                        data-focus-area="composer"
                        disabled={archived}
                        onChange={(event) => {
                            // A changed draft is a new message: it must not reuse the last one's id.
                            clientId.current = undefined;
                            draft.current = event.target.value;
                            setText(event.target.value);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder={t`Message the worker...`}
                        ref={textareaRef}
                        value={text}
                    />
                    <Button aria-label={t`Send`} disabled={!canSend} size="icon" type="submit">
                        <SendIcon aria-hidden="true" />
                    </Button>
                </div>
            </form>
        </div>
    );
};

export default WorkerComposer;
