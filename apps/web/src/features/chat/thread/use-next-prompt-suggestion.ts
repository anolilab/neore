/**
 * The suggested next prompt for the composer: the first of the newest reply's follow-up suggestions. The backend writes them once,
 * after the reply, with the utility model; this only reads that cache live. Nothing here calls a model.
 */
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { afterLastContextReset } from "@/features/chat/core/context/chat-action-shared";
import { useChatIsRunning, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import { useCRPC } from "@/lib/lunora/crpc";

import { pickNextPrompt } from "./next-prompt";

/** The next prompt to suggest in this chat's composer, or `null`. Off with the setting, and for a chat with no reply yet. */
const useNextPromptSuggestion = (): string | null => {
    const { threadId } = useChatThread();
    const { messages } = useChatMessages();
    const isRunning = useChatIsRunning();
    const { data: userSettings } = useUserSettings();
    const crpc = useCRPC();
    const unlockProof = useUnlockProof(threadId);

    const enabled = userSettings?.enableFollowupSuggestions !== false;
    const validThreadId = getValidThreadId(threadId);

    // The newest non-divider row, and only when it is a reply to something the person wrote: the rule the backend's generator keeps.
    const inContext = useMemo(() => afterLastContextReset(messages), [messages]);
    const lastMessage = inContext.findLast((message) => message.role !== "system") ?? null;
    const lastReplyId = lastMessage?.role === "assistant" && inContext.some((message) => message.role === "user") ? lastMessage.id : undefined;

    const { data: cached } = useQuery({
        ...crpc.chat.functions.getCachedFollowupSuggestions.queryOptions(
            validThreadId && enabled && !isRunning && lastReplyId !== undefined ? { threadId: validThreadId as Id<"threads">, unlockProof } : skipToken,
        ),
    });

    return pickNextPrompt({ cached, enabled, isRunning, lastReplyId });
};

export default useNextPromptSuggestion;
