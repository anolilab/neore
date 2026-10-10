"use client";

/**
 * ComposerVoiceInput - Speech-to-text button for the composer
 *
 * Two engines, one UI:
 * - ElevenLabs Scribe realtime (`dictation/elevenlabs-scribe.ts`) when
 *   `/api/scribe-token` can mint a token for this user;
 * - otherwise the browser's Web Speech API.
 *
 * Either way the transcript is written live into the composer — partial text
 * shows as it is recognised and is replaced once finalised — appended to
 * whatever the composer held when dictation started. Integrates with the
 * `audioRecordToggle` keyboard shortcut event.
 */

import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Loader2Icon, MicIcon, MicOffIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import type { ScribeSession } from "./dictation/elevenlabs-scribe";
import { fetchScribeToken, startScribeSession } from "./dictation/elevenlabs-scribe";
import { joinTranscript } from "./dictation/pcm";
import { canCaptureRealtime, getSpeechRecognition } from "./dictation/web-speech";

type DictationStatus = "connecting" | "idle" | "listening" | "stopping";

/** An active session of either engine, reduced to what the button needs. */
interface ActiveDictation {
    stop: () => Promise<void>;
}

/**
 * Live transcript bookkeeping: the composer text is always
 * `base + committed segments + current partial`, re-derived on every event so
 * a partial that the engine later revises is replaced rather than appended.
 */
const createTranscriptWriter = () => {
    const base = useChatUIStore.getState().composerText;
    const committed: string[] = [];
    let partial = "";

    const render = () => {
        useChatUIStore.getState().setComposerText(joinTranscript(base, ...committed, partial));
    };

    return {
        commit: (text: string) => {
            committed.push(text);
            partial = "";
            render();
        },
        /** Keeps whatever partial text is on screen as final — used on stop and on error. */
        finalize: () => {
            if (partial.trim()) {
                committed.push(partial);
            }

            partial = "";
            render();
        },
        partial: (text: string) => {
            partial = text;
            render();
        },
    };
};

interface ComposerVoiceInputProps {
    compact?: boolean;
    disabled?: boolean;
    /** Visually hide the button without unmounting (preserves active recognition session) */
    hidden?: boolean;
}

const ComposerVoiceInput: FC<ComposerVoiceInputProps> = ({ compact, disabled, hidden }) => {
    const { t } = useLingui();
    const [status, setStatus] = useState<DictationStatus>("idle");
    const sessionRef = useRef<ActiveDictation | null>(null);
    // Guards against a second start while the token / microphone are still pending.
    const busyRef = useRef(false);
    const isSupported = !!getSpeechRecognition() || canCaptureRealtime();
    const isListening = status !== "idle";

    const reportMicrophoneError = useCallback(
        (error: unknown) => {
            if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
                toast.error(t`Microphone access denied. Please allow microphone access in your browser settings.`);
            } else if (error instanceof DOMException && error.name === "NotFoundError") {
                toast.error(t`No microphone found.`);
            } else {
                const message = error instanceof Error ? error.message : String(error);

                toast.error(t`Speech recognition error: ${message}`);
            }
        },
        [t],
    );

    const startWebSpeech = useCallback((): ActiveDictation | null => {
        const SpeechRecognitionConstructor = getSpeechRecognition();

        if (!SpeechRecognitionConstructor) {
            toast.error(t`Speech recognition is not supported in your browser`);

            return null;
        }

        const recognition = new SpeechRecognitionConstructor();
        const writer = createTranscriptWriter();
        const session: ActiveDictation = {
            stop: async () => {
                recognition.stop();
            },
        };

        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || "en-US";

        recognition.onresult = (event) => {
            let interim = "";

            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const result = event.results[i];
                const transcript = result?.[0]?.transcript ?? "";

                if (result?.isFinal) {
                    writer.commit(transcript);
                } else {
                    interim += transcript;
                }
            }

            writer.partial(interim);
        };

        recognition.addEventListener("error", (event) => {
            if (event.error === "not-allowed") {
                toast.error(t`Microphone access denied. Please allow microphone access in your browser settings.`);
            } else if (event.error !== "aborted" && event.error !== "no-speech") {
                toast.error(t`Speech recognition error: ${event.error}`);
            }
        });

        recognition.onend = () => {
            writer.finalize();

            if (sessionRef.current === session) {
                sessionRef.current = null;
                setStatus("idle");
            }
        };

        recognition.start();

        return session;
    }, [t]);

    const startListening = useCallback(async () => {
        if (busyRef.current || sessionRef.current) {
            return;
        }

        busyRef.current = true;
        setStatus("connecting");

        try {
            // Created synchronously inside the gesture — see `startScribeSession`.
            const audioContext = canCaptureRealtime() ? new AudioContext() : null;
            const token = audioContext ? await fetchScribeToken() : null;

            if (audioContext && token) {
                const writer = createTranscriptWriter();
                let scribe: ScribeSession | null = null;
                const session: ActiveDictation = {
                    stop: async () => {
                        await scribe?.stop();
                        writer.finalize();
                    },
                };

                try {
                    scribe = await startScribeSession({
                        audioContext,
                        callbacks: {
                            onCommitted: writer.commit,
                            // The server closed the session by itself: back to idle, as Web Speech's `onend`.
                            onEnd: () => {
                                writer.finalize();

                                if (sessionRef.current === session) {
                                    sessionRef.current = null;
                                    setStatus("idle");
                                }
                            },
                            onError: (message) => {
                                writer.finalize();
                                toast.error(t`Speech recognition error: ${message}`);

                                if (sessionRef.current === session) {
                                    sessionRef.current = null;
                                    setStatus("idle");
                                }
                            },
                            onPartial: writer.partial,
                        },
                        token,
                    });
                } catch (error) {
                    reportMicrophoneError(error);
                    setStatus("idle");

                    return;
                }

                sessionRef.current = session;
                setStatus("listening");

                return;
            }

            void audioContext?.close().catch(() => undefined);

            const session = startWebSpeech();

            sessionRef.current = session;
            setStatus(session ? "listening" : "idle");
        } finally {
            busyRef.current = false;
        }
    }, [reportMicrophoneError, startWebSpeech, t]);

    const stopListening = useCallback(async () => {
        const session = sessionRef.current;

        if (!session) {
            return;
        }

        setStatus("stopping");

        try {
            await session.stop();
        } finally {
            if (sessionRef.current === session) {
                sessionRef.current = null;
            }

            setStatus("idle");
        }
    }, []);

    const toggleListening = useCallback(() => {
        if (status === "listening") {
            void stopListening();
        } else if (status === "idle") {
            void startListening();
        }
    }, [status, startListening, stopListening]);

    // Listen for keyboard shortcut event
    useEffect(() => {
        const handler = () => toggleListening();

        globalThis.addEventListener("audioRecordToggle", handler);

        return () => globalThis.removeEventListener("audioRecordToggle", handler);
    }, [toggleListening]);

    // Release the microphone if the composer unmounts mid-dictation.
    useEffect(
        () => () => {
            void sessionRef.current?.stop();
            sessionRef.current = null;
        },
        [],
    );

    if (!isSupported) {
        return null;
    }

    // Stay mounted but visually hidden so active recognition sessions survive
    if (hidden && !isListening) {
        return null;
    }

    const isPending = status === "connecting" || status === "stopping";
    const labels: Record<DictationStatus, string> = {
        connecting: t`Starting voice input…`,
        idle: t`Voice input`,
        listening: t`Stop listening`,
        stopping: t`Finishing transcription…`,
    };
    const label = labels[status];

    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {status === "listening" ? t`Listening` : ""}
            </span>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <button
                            aria-label={label}
                            aria-pressed={status === "listening"}
                            className={clsx(
                                buttonVariants({ size: "icon", variant: isListening ? "default" : "ghost" }),
                                "my-2 size-[34px]",
                                compact && "my-1.5 size-[30px]",
                                status === "listening" && "animate-pulse bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700",
                            )}
                            disabled={disabled || isPending}
                            onClick={toggleListening}
                            type="button"
                        >
                            {isPending && <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />}
                            {status === "listening" && <MicOffIcon aria-hidden="true" className="size-4 text-white" />}
                            {status === "idle" && <MicIcon aria-hidden="true" className="text-foreground size-4 dark:text-white" />}
                        </button>
                    }
                />
                <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
        </>
    );
};

export default ComposerVoiceInput;
