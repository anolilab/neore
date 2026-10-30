"use client";

/**
 * The composer of a worker's own thread. A worker takes a turn only through `dispatchToWorker`, so
 * this replaces the chat composer there: one message starts one run, and the run's reply lands in
 * the thread as it does for the lead's messages. The `clientId` is kept until the send is answered,
 * so a retry of a send that may have landed returns the same run instead of starting a second.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { SendIcon } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useRef, useState } from "react";

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
    const [text, setText] = useState("");
    const clientId = useRef<string | undefined>(undefined);
    const send = useMutation(crpc.sub_agents.functions.dispatchToWorker.mutationOptions());

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

        send.mutate(
            { clientId: clientId.current, message, workerId: workerId as Id<"threads"> },
            {
                onError: (error: unknown) => showError(error instanceof Error ? error : t`Could not send the message.`),
                onSuccess: () => {
                    clientId.current = undefined;
                    setText("");
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
        <form
            className={className}
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
                    disabled={archived}
                    onChange={(event) => {
                        // A changed draft is a new message: it must not reuse the last one's id.
                        clientId.current = undefined;
                        setText(event.target.value);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t`Message the worker...`}
                    value={text}
                />
                <Button aria-label={t`Send`} disabled={!canSend} size="icon" type="submit">
                    <SendIcon aria-hidden="true" />
                </Button>
            </div>
        </form>
    );
};

export default WorkerComposer;
