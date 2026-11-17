"use client";

/**
 * Tells screen-reader users which tool the agent just started, while the reply is
 * still being written: "Using search". Only calls that appear after this mounted
 * (or after a thread switch) count, so opening a thread mid-turn announces nothing
 * that was already running. The newest new call wins when several start in one
 * render. The region stays mounted, like the reply announcement's, so a change in
 * its text is what the reader hears.
 */

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useState } from "react";

import { useChatIsStreaming, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";

import { freshToolSteps, inFlightReply, knownToolCalls } from "./turn-announcements";
import type { SpokenStep } from "./use-spoken-step";
import { useSpokenStep } from "./use-spoken-step";

interface StepState {
    /** Whether the calls present when the list became ready are the baseline. Nothing is said before that. */
    baselined: boolean;
    /** Tool call keys already seen, announced or not. */
    known: ReadonlySet<string>;
    /** The newest step to say. A new object per step, so a repeated name is still a change. */
    step: SpokenStep | null;
    threadId: string | null | undefined;
}

const TurnStepAnnouncement: FC = () => {
    const { t } = useLingui();
    const { messages, messagesReady } = useChatMessages();
    // This thread's own stream: the global flag is also on while another chat streams, and would make a settled reply here look live.
    const { isThreadStreaming: isStreaming } = useChatIsStreaming();
    const { threadId } = useChatThread();
    const [state, setState] = useState<StepState>(() => {
        return { baselined: messagesReady, known: knownToolCalls(messages), step: null, threadId };
    });
    const spoken = useSpokenStep(state.step, threadId);

    // Adjusted while rendering (React's sanctioned alternative to an effect that only sets state).
    if (state.step && !inFlightReply(messages, isStreaming)) {
        // The reply ended: a step still waiting to speak is dropped, and a resumed stream must not repeat it.
        setState({ ...state, step: null });
    } else if (state.threadId === threadId && state.baselined) {
        const fresh = freshToolSteps(messages, state.known, isStreaming);
        const newest = fresh.at(-1);

        if (newest) {
            setState({
                baselined: true,
                known: new Set([...state.known, ...fresh.map((step) => step.key)]),
                step: { label: t`Using ${newest.toolName}`, threadId },
                threadId,
            });
        }
    } else if (state.threadId === threadId) {
        // A thread that opens mid-turn loads its list later: the calls in it then were running before the reader arrived.
        if (messagesReady) {
            setState({ baselined: true, known: knownToolCalls(messages), step: null, threadId });
        }
    } else {
        setState({ baselined: messagesReady, known: knownToolCalls(messages), step: null, threadId });
    }

    return (
        <span aria-live="polite" className="sr-only" role="status">
            {spoken}
        </span>
    );
};

export default TurnStepAnnouncement;
