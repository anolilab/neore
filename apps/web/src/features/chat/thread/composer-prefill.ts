"use client";

/**
 * Puts a prompt into one thread's composer for the person to read and send. Never sends: the composer only takes the
 * text (after what is already typed) and gets focus. A request waits for the composer of ITS thread, so a request
 * made while that thread is not open is taken when it opens, and another thread's composer leaves it alone.
 */

import { useEffect, useEffectEvent } from "react";

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

interface ComposerPrefill {
    text: string;
    threadId: string;
}

const prefillChannel = createRequestChannel<ComposerPrefill>();

export const prefillComposer = (threadId: string, text: string): void => {
    prefillChannel.request({ text, threadId });
};

/** The composer of `threadId` takes each prompt meant for it; `undefined` (a new chat) takes none. */
export const useComposerPrefill = (threadId: string | undefined, onPrefill: (text: string) => void): void => {
    const handle = useEffectEvent(onPrefill);

    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        return prefillChannel.consume(
            (request) => handle(request.text),
            (request) => request.threadId === threadId,
        );
    }, [threadId]);
};
