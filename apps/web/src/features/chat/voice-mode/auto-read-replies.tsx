"use client";

/**
 * "Auto-read replies" (`userSettings.autoReadReplies`, opt-in): speaks every
 * reply that finishes streaming in this thread, outside hands-free mode too.
 * Renders nothing.
 *
 * Only replies that STREAMED while this was mounted are read — opening a
 * thread never reads its history — and hands-free mode, which speaks replies
 * itself, takes precedence.
 */

import type { FC } from "react";
import { useEffect, useEffectEvent, useRef } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";

import type { SpeakableMessage } from "./reply-speech";
import { findFinishedReply, latestAssistantId } from "./reply-speech";
import type { SpeechHandle } from "./speaker";
import useSpeakReply from "./use-speak-reply";
import { useVoiceModeStore } from "./voice-mode-store";

const AutoReadWatcher: FC = () => {
    const { isStreaming, messages } = useChatMessages();
    const { threadId } = useChatThread();
    const speak = useSpeakReply();
    const baselineRef = useRef<string | null>(null);
    const sawStreamingRef = useRef(false);
    const handleRef = useRef<SpeechHandle | null>(null);
    // Bumped by every new read and every thread change: a read that resolves
    // after either (the skill lookup awaits a round trip) is cancelled, not heard.
    const generationRef = useRef(0);

    const resetBaseline = useEffectEvent(() => {
        baselineRef.current = latestAssistantId(messages);
        sawStreamingRef.current = false;
    });

    const speakFinished = useEffectEvent(async (reply: SpeakableMessage) => {
        generationRef.current += 1;

        const generation = generationRef.current;

        handleRef.current?.cancel();
        handleRef.current = null;

        const handle = await speak(messages, reply, () => generation !== generationRef.current);

        if (generation === generationRef.current) {
            handleRef.current = handle;
        } else {
            handle.cancel();
        }
    });

    // A new thread starts from whatever it already holds; stop reading the old one.
    useEffect(() => {
        resetBaseline();

        return () => {
            generationRef.current += 1;
            handleRef.current?.cancel();
            handleRef.current = null;
        };
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

        if (!finished.failed && useVoiceModeStore.getState().state.phase === "idle") {
            void speakFinished(finished.message);
        }
    }, [isStreaming, messages]);

    return null;
};

const AutoReadReplies: FC = () => {
    const { data: userSettings } = useUserSettings();

    return userSettings?.autoReadReplies === true ? <AutoReadWatcher /> : null;
};

export default AutoReadReplies;
