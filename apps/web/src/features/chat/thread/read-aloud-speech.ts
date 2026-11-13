import { useEffect, useRef } from "react";

import { stopReplySpeech } from "@/features/chat/voice-mode/speaker";

import { splitForSpeech, toSpeakableText } from "./read-aloud-text";

/**
 * Browser read-aloud via `speechSynthesis`. Only one message speaks at a time, so the id of the speaking
 * message lives here, above the rows: a row the list unmounts (virtualized out of view) does not end
 * the speech, and its action shows "stop" again when it remounts. The message list ends it instead
 * (`useEndReadAloudWithMessages`), when the thread is left or the speaking message is gone.
 */
const speech: { speakingId: string | null } = { speakingId: null };
const listeners = new Set<() => void>();

const setSpeakingId = (id: string | null) => {
    speech.speakingId = id;

    for (const listener of listeners) {
        listener();
    }
};

export const subscribeToReadAloud = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

export const getReadAloudId = (): string | null => speech.speakingId;

export const isSpeechSupported = (): boolean => globalThis.window !== undefined && "speechSynthesis" in globalThis && "SpeechSynthesisUtterance" in globalThis;

export const stopReadAloud = (): void => {
    if (isSpeechSupported()) {
        globalThis.speechSynthesis.cancel();
    }

    setSpeakingId(null);
};

export const readAloud = (id: string, markdown: string, lang: string | undefined): void => {
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

/**
 * Ends read-aloud of one of these messages when it leaves them (deleted, or the list now shows another
 * thread) and when the list unmounts. Speech of a message the list never held (another pane's) goes on.
 */
export const useEndReadAloudWithMessages = (messageIds: ReadonlyArray<string>): void => {
    const heldRef = useRef<ReadonlySet<string>>(new Set());

    useEffect(() => {
        const held = new Set(messageIds);
        const { speakingId } = speech;

        if (speakingId !== null && heldRef.current.has(speakingId) && !held.has(speakingId)) {
            stopReadAloud();
        }

        heldRef.current = held;
    }, [messageIds]);

    useEffect(
        () => () => {
            const { speakingId } = speech;

            if (speakingId !== null && heldRef.current.has(speakingId)) {
                stopReadAloud();
            }
        },
        [],
    );
};
