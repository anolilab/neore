"use client";

/**
 * "Sound effects" (`preferences.soundEffects`, opt-in, this browser only): plays
 * a short ping when a reply finishes streaming in this thread. Renders nothing.
 *
 * Like auto-read, only replies that STREAMED while this was mounted ping —
 * opening a thread never does — and a failed reply stays silent.
 */

import type { FC } from "react";
import { useEffect, useEffectEvent, useRef } from "react";

import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { findFinishedReply } from "@/features/chat/voice-mode/reply-speech";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import playCompletionPing from "./completion-ping";

const UNSETTLED_STATUSES = new Set(["pending", "streaming"]);

/**
 * The newest assistant reply that has settled. A reply still streaming when the
 * watcher mounts is not history: it is the one this watcher should ping for.
 */
const latestSettledAssistantId = (messages: ReadonlyArray<{ id: string; role: string; status: string }>): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role === "assistant" && !UNSETTLED_STATUSES.has(message.status)) {
            return message.id;
        }
    }

    return null;
};

const CompletionSoundWatcher: FC = () => {
    const { isStreaming, messages } = useChatMessages();
    const { threadId } = useChatThread();
    const baselineRef = useRef<string | null>(null);
    const sawStreamingRef = useRef(false);

    const resetBaseline = useEffectEvent(() => {
        baselineRef.current = latestSettledAssistantId(messages);
        sawStreamingRef.current = false;
    });

    useEffect(() => {
        resetBaseline();
    }, [threadId]);

    useEffect(() => {
        if (isStreaming) {
            sawStreamingRef.current = true;

            return;
        }

        if (!sawStreamingRef.current) {
            return;
        }

        const finished = findFinishedReply(messages, { baselineId: baselineRef.current, isStreaming });

        if (!finished) {
            return;
        }

        baselineRef.current = finished.message.id;
        sawStreamingRef.current = false;

        if (!finished.failed) {
            playCompletionPing();
        }
    }, [isStreaming, messages]);

    return null;
};

const CompletionSound: FC = () => {
    const soundEffects = useUIStateStore((state) => state.preferences.soundEffects);

    return soundEffects ? <CompletionSoundWatcher /> : null;
};

export default CompletionSound;
