"use client";

import { useLingui } from "@lingui/react/macro";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { SquareIcon, Volume2Icon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { stopReplySpeech } from "@/features/chat/voice-mode/speaker";

import { splitForSpeech, toSpeakableText } from "./read-aloud-text";

/**
 * Browser read-aloud via `speechSynthesis` — free, instant and never persisted.
 * Distinct from "Generate voice", which renders an audio file with a paid
 * registry TTS model. Only one message speaks at a time, so the id of the
 * speaking message lives in a module-level store every action bar subscribes to.
 */
const speech: { speakingId: string | null } = { speakingId: null };
const listeners = new Set<() => void>();

const setSpeakingId = (id: string | null) => {
    speech.speakingId = id;

    for (const listener of listeners) {
        listener();
    }
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

const getSnapshot = () => speech.speakingId;
const getServerSnapshot = () => null;
const noopSubscribe = () => () => {};
const getServerSupport = () => false;

const isSpeechSupported = (): boolean => globalThis.window !== undefined && "speechSynthesis" in globalThis && "SpeechSynthesisUtterance" in globalThis;

const stopSpeaking = () => {
    if (isSpeechSupported()) {
        globalThis.speechSynthesis.cancel();
    }

    setSpeakingId(null);
};

const speak = (id: string, markdown: string, lang: string | undefined) => {
    const chunks = splitForSpeech(toSpeakableText(markdown));

    // A spoken reply (hands-free / auto-read, possibly TTS audio) stops too.
    stopReplySpeech();
    // `cancel()` fires `end`/`error` on the utterances it drops; the id guard below
    // keeps those from clearing the NEW speaking state.
    globalThis.speechSynthesis.cancel();

    if (chunks.length === 0) {
        setSpeakingId(null);

        return;
    }

    setSpeakingId(id);

    chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk);

        if (lang) {
            utterance.lang = lang;
        }

        const finish = () => {
            if (speech.speakingId === id) {
                setSpeakingId(null);
            }
        };

        utterance.addEventListener("error", finish);

        if (index === chunks.length - 1) {
            utterance.addEventListener("end", finish);
        }

        globalThis.speechSynthesis.speak(utterance);
    });
};

interface ReadAloudActionProps {
    /** Language of the message, when known; the browser's voice default otherwise. */
    lang?: string;
    messageId: string;
    text: string;
}

const ReadAloudAction: FC<ReadAloudActionProps> = ({ lang, messageId, text }) => {
    const { t } = useLingui();
    const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    // Server snapshot `false`, so hydration matches the SSR markup and the button
    // appears on the client's follow-up render.
    const isSupported = useSyncExternalStore(noopSubscribe, isSpeechSupported, getServerSupport);
    const isSpeaking = current === messageId;

    // Stop when the message that is speaking unmounts (thread switch, deletion).
    useEffect(
        () => () => {
            if (speech.speakingId === messageId) {
                stopSpeaking();
            }
        },
        [messageId],
    );

    const handleClick = useCallback(() => {
        if (isSpeaking) {
            stopSpeaking();
        } else {
            speak(messageId, text, lang);
        }
    }, [isSpeaking, lang, messageId, text]);

    if (!isSupported) {
        return null;
    }

    return (
        <MessageAction onClick={handleClick} tooltip={isSpeaking ? t`Stop reading` : t`Read aloud`}>
            {isSpeaking ? <SquareIcon aria-hidden="true" className="size-4" /> : <Volume2Icon aria-hidden="true" className="size-4" />}
        </MessageAction>
    );
};

export default ReadAloudAction;
