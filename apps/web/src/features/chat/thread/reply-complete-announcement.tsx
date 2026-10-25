"use client";

/**
 * Tells screen-reader users that a reply has finished streaming (WCAG 4.1.3).
 * One short phrase per reply, never the reply's text. The region stays mounted
 * for the whole thread, since the streaming placeholder unmounts the moment the
 * stream ends and a live region that appears already filled is not announced.
 *
 * Independent of the opt-in completion sound. Like it, only a reply that
 * STREAMED while this was mounted counts (opening a thread announces nothing),
 * and a failed reply is not "complete".
 */

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useState } from "react";

import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { findFinishedReply, latestAssistantId, latestSettledAssistantId } from "@/features/chat/voice-mode/reply-speech";

interface AnnouncementState {
    announced: boolean;

    /**
     * The newest settled reply as of the last idle render. A send or regenerate that
     * fails leaves that reply last again, which must not read as a new one.
     */
    baselineId: string | null;
    /** A reply streamed since the last announcement, so its completion is still owed. */
    streamed: boolean;
    threadId: string | null | undefined;
}

/**
 * Whether a reply is on its way in THIS message list: the prompt is last, or the newest
 * assistant row has not settled. `isStreaming` alone can still describe the previous
 * thread for a render after a switch, and counting it would announce the new thread's
 * history as it loads.
 */
const isReplyInFlight = (messages: ReadonlyArray<{ id: string; role: string; status: string; text: string }>): boolean =>
    messages.at(-1)?.role === "user" || latestAssistantId(messages) !== latestSettledAssistantId(messages);

const ReplyCompleteAnnouncement: FC = () => {
    const { t } = useLingui();
    const { isStreaming, messages } = useChatMessages();
    const { threadId } = useChatThread();
    const [state, setState] = useState<AnnouncementState>({
        announced: false,
        baselineId: latestSettledAssistantId(messages),
        streamed: isStreaming && isReplyInFlight(messages),
        threadId,
    });

    // Adjusted while rendering (React's sanctioned alternative to an effect that only sets state).
    if (state.threadId !== threadId) {
        setState({ announced: false, baselineId: latestSettledAssistantId(messages), streamed: false, threadId });
    } else if (isStreaming) {
        // Empty again while the next reply streams, so its completion is a change the reader hears.
        const observed = state.streamed || isReplyInFlight(messages);

        if (observed !== state.streamed || state.announced) {
            setState({ ...state, announced: false, streamed: observed });
        }
    } else if (state.streamed) {
        const finished = findFinishedReply(messages, { baselineId: state.baselineId, isStreaming });

        if (finished) {
            setState({ announced: !finished.failed, baselineId: finished.message.id, streamed: false, threadId });
        }
    } else {
        const settledId = latestSettledAssistantId(messages);

        // Idle: follow the thread, so history that loads after mount is the baseline too.
        if (settledId !== state.baselineId) {
            setState({ ...state, baselineId: settledId });
        }
    }

    return (
        <span aria-live="polite" className="sr-only" role="status">
            {state.announced ? t`Reply complete` : null}
        </span>
    );
};

export default ReplyCompleteAnnouncement;
