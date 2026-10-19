"use client";

/**
 * EditComposer - Inline editor for user messages and assistant replies
 *
 * A user message is submitted via editMessage from context (a new reply is
 * generated). A reply's text is replaced in place by `agent_branches.editAssistantReply`,
 * with no model call. Receives the message as a prop to display original content during exit animation.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Separator } from "@neore/ui/components/separator";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import type { ChangeEvent, FC, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { useChatActions, useChatThread } from "@/features/chat/core/context/chat-context";
import { isValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

interface EditComposerProps {
    message: UIMessage;
}

const EditComposer: FC<EditComposerProps> = ({ message }) => {
    const { t } = useLingui();
    const { editMessage } = useChatActions();
    const { threadId } = useChatThread();
    const crpc = useCRPC();
    const { isPending, mutateAsync: editReply } = useMutation(crpc.agent.branches.editAssistantReply.mutationOptions());

    // Edit state from store
    const stopEditing = useChatUIStore((state) => state.stopEditing);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Local state for the text being edited (initialized from message)
    const [editText, setEditText] = useState(message.text || "");

    // Focus textarea on mount and move cursor to end
    useEffect(() => {
        if (!textareaRef.current) {
            return;
        }

        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.value.length;
        textareaRef.current.selectionEnd = textareaRef.current.value.length;
    }, []);

    // Auto-resize textarea
    useEffect(() => {
        const textarea = textareaRef.current;

        if (!textarea) {
            return;
        }

        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
    }, [editText]);

    const handleSubmit = async () => {
        if (!editText.trim() || isPending) {
            return;
        }

        if (message.role !== "assistant") {
            await editMessage(message.id, editText.trim());
            stopEditing();

            return;
        }

        if (!isValidThreadId(threadId)) {
            return;
        }

        try {
            // The reactive message list delivers the saved reply, so nothing to refresh here.
            await editReply({ messageId: message.id, text: editText.trim(), threadId: threadId as Id<"threads"> });
            stopEditing();
        } catch (error) {
            // Stay open with the text kept, so the edit can be retried.
            showError(error as Error);
        }
    };

    const handleCancel = () => {
        stopEditing();
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            handleCancel();
        }
    };

    const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
        setEditText(e.target.value);
    };

    return (
        <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-sidebar border-sidebar-foreground relative z-10 mt-4 mb-6 w-full rounded-lg border p-1"
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
        >
            <div className="outline-border bg-sidebar-foreground flex w-full flex-col items-start justify-end rounded-lg px-2.5 outline backdrop-blur-md transition-shadow focus-within:shadow-md dark:border-neutral-700 dark:outline-[#181818]!">
                <div className="flex w-full flex-row items-center justify-center gap-2">
                    <button
                        aria-label={t`Add attachment`}
                        className="text-foreground mb-0 flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-100 dark:text-white dark:hover:bg-gray-800"
                        disabled
                        type="button"
                    >
                        <PlusIcon aria-hidden="true" className="size-5" />
                    </button>
                    <div className="my-4 h-full">
                        <Separator className="h-6" orientation="vertical" />
                    </div>
                    <textarea
                        className="text-foreground focus-visible:ring-ring/50 ml-1 flex min-h-8 w-full resize-none bg-transparent py-2 outline-none focus-visible:ring-1"
                        onChange={handleTextChange}
                        onKeyDown={handleKeyDown}
                        placeholder={message.role === "assistant" ? t`Edit the reply...` : t`Edit your message...`}
                        ref={textareaRef}
                        rows={1}
                        value={editText}
                    />
                </div>
            </div>

            <div className="m-1.5 flex items-center justify-end gap-2 self-end">
                <Button onClick={handleCancel} size="sm" variant="ghost">
                    <XIcon className="mr-1 h-4 w-4" />
                    {t`Cancel`}
                </Button>
                <Button disabled={!editText.trim() || isPending} onClick={handleSubmit} size="sm" variant="default">
                    <CheckIcon className="mr-1 h-4 w-4" />
                    {t`Save`}
                </Button>
            </div>
        </motion.div>
    );
};

export default EditComposer;
