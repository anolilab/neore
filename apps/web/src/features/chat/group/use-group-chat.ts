import { skipToken, useQuery } from "@tanstack/react-query";

import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * A thread's group-chat setup (`chat_group_functions.getGroupChat`): mode and
 * participants, or `null` for an ordinary thread. Names and descriptions only —
 * the backend never sends a participant's instructions.
 */
export const useGroupChat = (threadId: string | undefined) => {
    const crpc = useCRPC();
    const validThreadId = getValidThreadId(threadId);

    const { data } = useQuery(crpc.chat.group.functions.getGroupChat.queryOptions(validThreadId ? { threadId: validThreadId } : skipToken));

    return data ?? null;
};

export type GroupChatData = NonNullable<ReturnType<typeof useGroupChat>>;
export type GroupParticipant = GroupChatData["participants"][number];
