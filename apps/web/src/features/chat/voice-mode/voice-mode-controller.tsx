"use client";

/**
 * Runs the hands-free loop while voice mode is on; renders nothing.
 *
 * Lazy-loaded by `VoiceModeButton` the first time the mode starts, so the
 * dictation engines and speech code stay off the chat's startup path. Each
 * phase of `voice-mode-machine.ts` owns one effect:
 *
 * - `listening` — a fresh dictation session; the live transcript is mirrored
 *   into the composer and a finished utterance (`utterance-detector.ts`) is sent;
 * - `waiting`   — watches the thread until the reply after the send finishes;
 * - `speaking`  — reads it aloud (registry TTS, browser voice as the fallback),
 *   then listens again. Leaving `speaking` any way — Esc, the toggle, a thread
 *   switch that remounts this component — cancels the speech.
 *
 * `STOP` (the toggle or Esc) moves the machine to `idle`, which unmounts this
 * component and so tears down whichever session was running.
 */

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useChatActions, useChatError, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { joinTranscript } from "@/features/chat/thread/dictation/pcm";

import type { ListenErrorKind, ListenSession } from "./listen";
import { classifyListenError, startListening } from "./listen";
import type { SpeakableMessage } from "./reply-speech";
import { findFinishedReply, latestAssistantId } from "./reply-speech";
import type { SpeechHandle } from "./speaker";
import useSpeakReply from "./use-speak-reply";
import { createUtteranceDetector } from "./utterance-detector";
import { sendVoiceModeEvent, useVoiceModeStore } from "./voice-mode-store";

/** A session ends after a long silence (Web Speech itself, or `NO_SPEECH_TIMEOUT_MS`); restart it this many times in a row before giving up. */
const MAX_QUIET_RESTARTS = 5;
/** A controller that unmounts (leaving the chat) and is not replaced within this window stops the loop. */
const UNMOUNT_STOP_DELAY_MS = 2000;

const mounted = { count: 0 };

/** Called when a controller unmounts: stops the loop unless another controller mounts (thread navigation) in time. */
const stopUnlessRemounted = (): void => {
    setTimeout(() => {
        if (mounted.count === 0) {
            sendVoiceModeEvent({ type: "STOP" });
        }
    }, UNMOUNT_STOP_DELAY_MS);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const VoiceModeController: FC = () => {
    const { t } = useLingui();
    const phase = useVoiceModeStore((store) => store.state.phase);
    const { sendMessage } = useChatActions();
    const { error: chatError } = useChatError();
    const { isStreaming, messages } = useChatMessages();
    const { threadId } = useChatThread();
    const { data: userSettings } = useUserSettings();
    const speak = useSpeakReply({ registryTts: true });
    const [restartKey, setRestartKey] = useState(0);
    const quietRestartsRef = useRef(0);
    const replyRef = useRef<SpeakableMessage | null>(null);
    const sentThreadRef = useRef<string | null>(null);

    // Read when a session starts, so a settings refetch never restarts one mid-utterance.
    const getDictationLanguage = useEffectEvent(() => userSettings?.dictationLanguage);

    const fail = useEffectEvent((message: string) => {
        toast.error(message);
        sendVoiceModeEvent({ message, type: "ERROR" });
    });

    const reportListenError = useEffectEvent((error: unknown) => {
        const texts: Record<ListenErrorKind, string> = {
            denied: t`Microphone access denied. Please allow microphone access in your browser settings.`,
            missing: t`No microphone found.`,
            other: t`Speech recognition error: ${errorText(error)}`,
            unsupported: t`Speech recognition is not supported in your browser`,
        };

        fail(texts[classifyListenError(error)]);
    });

    const sendUtterance = useEffectEvent(async (text: string) => {
        sendVoiceModeEvent({ text, type: "UTTERANCE" });
        useVoiceModeStore.getState().setBaselineReplyId(latestAssistantId(messages));
        sentThreadRef.current = threadId ?? null;
        useChatUIStore.getState().setComposerText("");

        const sent = await sendMessage(text)
            .then(() => true)
            .catch((error: unknown) => {
                fail(t`Could not send your message: ${errorText(error)}`);

                return false;
            });

        if (sent) {
            sendVoiceModeEvent({ type: "SENT" });
        }
    });

    // Stop when the chat goes away for good; a thread navigation remounts a
    // new controller within the delay and keeps the loop.
    useEffect(() => {
        mounted.count += 1;

        return () => {
            mounted.count -= 1;
            stopUnlessRemounted();
        };
    }, []);

    // Esc stops the mode — unless something else (a dialog, a popup) already handled it.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
                sendVoiceModeEvent({ type: "STOP" });
            }
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => globalThis.removeEventListener("keydown", onKeyDown);
    }, []);

    // A send interrupted by a remount (the first message of a new chat
    // navigates to its thread) still resolves in the old closure; if it did
    // not, move on rather than sit in `sending`.
    useEffect(() => {
        if (phase === "sending" && !isStreaming && messages.at(-1)?.role === "user") {
            sendVoiceModeEvent({ type: "SENT" });
        }
    }, [isStreaming, messages, phase]);

    const onQuietEnd = useEffectEvent(() => {
        quietRestartsRef.current += 1;

        if (quietRestartsRef.current > MAX_QUIET_RESTARTS) {
            fail(t`No speech detected. Hands-free mode stopped.`);

            return;
        }

        setRestartKey((key) => key + 1);
    });

    // ── listening ──
    useEffect(() => {
        if (phase !== "listening") {
            return undefined;
        }

        let disposed = false;
        let session: ListenSession | null = null;
        const base = useChatUIStore.getState().composerText;
        const detector = createUtteranceDetector({
            onTranscript: (text) => {
                if (text) {
                    quietRestartsRef.current = 0;
                }

                useChatUIStore.getState().setComposerText(joinTranscript(base, text));
            },
            onUtterance: (text) => {
                void session?.stop();
                void sendUtterance(joinTranscript(base, text));
            },
        });

        const begin = async (): Promise<void> => {
            const started = await startListening(
                {
                    onCommitted: detector.commit,
                    onEnd: () => {
                        detector.flush();

                        if (!disposed && useVoiceModeStore.getState().state.phase === "listening") {
                            onQuietEnd();
                        }
                    },
                    onError: (message) => {
                        if (!disposed) {
                            reportListenError(new Error(message));
                        }
                    },
                    onPartial: detector.partial,
                },
                getDictationLanguage(),
            ).catch((error: unknown) => {
                if (!disposed) {
                    reportListenError(error);
                }

                return null;
            });

            if (started && disposed) {
                void started.stop();
            } else {
                session = started;
            }
        };

        void begin();

        return () => {
            disposed = true;
            detector.dispose();
            void session?.stop();
        };
    }, [phase, restartKey]);

    // ── waiting ──
    useEffect(() => {
        if (phase !== "waiting") {
            return;
        }

        if (chatError) {
            fail(chatError.message);

            return;
        }

        // The user switched to another thread mid-turn: that reply is not this one.
        if (sentThreadRef.current !== null && threadId !== sentThreadRef.current) {
            sendVoiceModeEvent({ type: "STOP" });

            return;
        }

        const finished = findFinishedReply(messages, { baselineId: useVoiceModeStore.getState().baselineReplyId, isStreaming });

        if (!finished) {
            return;
        }

        replyRef.current = finished.failed ? null : finished.message;
        sendVoiceModeEvent({ text: finished.failed ? "" : finished.message.text, type: "REPLY_FINISHED" });
    }, [chatError, isStreaming, messages, phase, threadId]);

    const startSpeaking = useEffectEvent((reply: SpeakableMessage) => speak(messages, reply));

    // ── speaking ──
    useEffect(() => {
        if (phase !== "speaking") {
            return undefined;
        }

        const reply = replyRef.current;

        if (!reply) {
            sendVoiceModeEvent({ type: "SPEECH_ENDED" });

            return undefined;
        }

        let cancelled = false;
        let handle: SpeechHandle | null = null;

        const run = async (): Promise<void> => {
            const started = await startSpeaking(reply).catch(() => null);

            if (cancelled) {
                started?.cancel();

                return;
            }

            handle = started;
            await started?.done;

            if (!cancelled) {
                sendVoiceModeEvent({ type: "SPEECH_ENDED" });
            }
        };

        void run();

        return () => {
            cancelled = true;
            handle?.cancel();
        };
    }, [phase]);

    return null;
};

export default VoiceModeController;
