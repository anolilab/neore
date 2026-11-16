import { isCompactCommand } from "@/features/chat/compaction/compaction-logic";
import { isClearCommand } from "@/features/chat/context-reset/context-reset-logic";

/**
 * What a composer submit does with its draft:
 * - `compact` / `clear`: runs the command, and sends nothing;
 * - `queue`: joins the thread's local queue, as a reply is still streaming;
 * - `wait`: nothing, as a reply is streaming and this composer has no queue (a comparison, a new chat);
 * - `send`: sends it.
 */
export type ComposerSubmitIntent = "clear" | "compact" | "queue" | "send" | "wait";

export interface ComposerSubmitState {
    hasAttachments: boolean;
    isComparisonValid: boolean;
    isStreaming: boolean;
    isThreadComposer: boolean;
    text: string;
    threadId: string | null | undefined;
}

/** The one place `handleSubmit` and its offline guard learn which branch a draft takes. */
export const composerSubmitIntent = ({
    hasAttachments,
    isComparisonValid,
    isStreaming,
    isThreadComposer,
    text,
    threadId,
}: ComposerSubmitState): ComposerSubmitIntent => {
    // A new chat has no thread yet: a command still runs there, and answers why it cannot.
    if (!hasAttachments && (isThreadComposer || !threadId)) {
        if (isCompactCommand(text)) {
            return "compact";
        }

        if (isClearCommand(text)) {
            return "clear";
        }
    }

    if (isStreaming) {
        return isThreadComposer && !isComparisonValid && threadId ? "queue" : "wait";
    }

    return "send";
};
