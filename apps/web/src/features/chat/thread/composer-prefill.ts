/**
 * Puts text into one thread's composer from UI that is not part of it (a header chip). It never sends: the person reads,
 * edits and sends it. A request waits until that thread's composer takes it, so a split pane of another chat leaves it alone.
 */

import { useEffect } from "react";

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

interface ComposerPrefill {
    text: string;
    threadId: string;
}

const prefillChannel = createRequestChannel<ComposerPrefill>();

export const prefillComposer = (threadId: string, text: string): void => {
    prefillChannel.request({ text, threadId });
};

/** The thread composer subscribes with this; `apply` receives each text meant for `threadId`. */
export const useComposerPrefill = (threadId: string | undefined, apply: (text: string) => void): void => {
    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        return prefillChannel.consume(
            (request: ComposerPrefill) => apply(request.text),
            (request: ComposerPrefill) => request.threadId === threadId,
        );
    }, [apply, threadId]);
};
