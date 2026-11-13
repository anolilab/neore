"use client";

import { useLingui } from "@lingui/react/macro";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { SquareIcon, Volume2Icon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useSyncExternalStore } from "react";

import { getReadAloudId, isSpeechSupported, readAloud, stopReadAloud, subscribeToReadAloud } from "./read-aloud-speech";

/**
 * Browser read-aloud via `speechSynthesis` — free, instant and never persisted.
 * Distinct from "Generate voice", which renders an audio file with a paid
 * registry TTS model. The speaking state lives in `read-aloud-speech.ts`, above the
 * row, so a row virtualized out of view does not stop it.
 */
const getServerSnapshot = () => null;
const noopSubscribe = () => () => {};
const getServerSupport = () => false;

interface ReadAloudActionProps {
    /** Language of the message, when known; the browser's voice default otherwise. */
    lang?: string;
    messageId: string;
    text: string;
}

const ReadAloudAction: FC<ReadAloudActionProps> = ({ lang, messageId, text }) => {
    const { t } = useLingui();
    const current = useSyncExternalStore(subscribeToReadAloud, getReadAloudId, getServerSnapshot);
    // Server snapshot `false`, so hydration matches the SSR markup and the button
    // appears on the client's follow-up render.
    const isSupported = useSyncExternalStore(noopSubscribe, isSpeechSupported, getServerSupport);
    const isSpeaking = current === messageId;

    const handleClick = useCallback(() => {
        if (isSpeaking) {
            stopReadAloud();
        } else {
            readAloud(messageId, text, lang);
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
