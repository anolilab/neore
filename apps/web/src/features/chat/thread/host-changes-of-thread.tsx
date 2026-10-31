"use client";

import type { FC } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import type { UIMessage } from "@/lib/agent";

import HostChanges from "./host-changes";

/**
 * The changes of a host turn in the thread they belong to. Only the thread's owner can comment on them: a comment
 * becomes a message to the agent on the owner's computer, which `POST /hosts/send` refuses for anyone else. A viewer
 * the thread is shared with sees the diff read-only. Read here so only these rows follow the thread context.
 */
const HostChangesOfThread: FC<{ changes: NonNullable<UIMessage["hostChanges"]>; messageId: string }> = ({ changes, messageId }) => {
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;

    return isOwner ? <HostChanges changes={changes} messageId={messageId} threadId={threadId} /> : <HostChanges changes={changes} />;
};

export default HostChangesOfThread;
