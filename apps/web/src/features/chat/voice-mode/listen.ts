/**
 * One listening turn for hands-free mode, on the same two engines as composer
 * dictation: ElevenLabs Scribe realtime when `/api/scribe-token` mints a token
 * (VAD commits), otherwise the Web Speech API (`isFinal` results).
 *
 * A fresh session per turn, never one held open across the loop: Scribe bills
 * audio time and caps session length, and the microphone would otherwise pick
 * up the reply being spoken.
 */

import type { ScribeSession } from "@/features/chat/thread/dictation/elevenlabs-scribe";
import { fetchScribeToken, startScribeSession } from "@/features/chat/thread/dictation/elevenlabs-scribe";
import { canCaptureRealtime, getSpeechRecognition } from "@/features/chat/thread/dictation/web-speech";

export interface ListenCallbacks {
    onCommitted: (text: string) => void;
    /** The engine ended the session by itself (Web Speech does after a long silence). */
    onEnd: () => void;
    onError: (message: string) => void;
    onPartial: (text: string) => void;
}

export interface ListenSession {
    stop: () => Promise<void>;
}

export class ListenUnsupportedError extends Error {
    public constructor() {
        super("Speech recognition is not supported in this browser");
        this.name = "ListenUnsupportedError";
    }
}

export type ListenErrorKind = "denied" | "missing" | "other" | "unsupported";

/** Web Speech `error` codes, which arrive as the message of an `onError`. */
const WEB_SPEECH_DENIED = new Set(["not-allowed", "service-not-allowed"]);
const WEB_SPEECH_MISSING = new Set(["audio-capture"]);

/** Which message a failed listen gets: a thrown start error, or an engine's `onError` wrapped in an `Error`. */
export const classifyListenError = (error: unknown): ListenErrorKind => {
    if (error instanceof ListenUnsupportedError) {
        return "unsupported";
    }

    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        return "denied";
    }

    if (error instanceof DOMException && error.name === "NotFoundError") {
        return "missing";
    }

    if (error instanceof Error && WEB_SPEECH_DENIED.has(error.message)) {
        return "denied";
    }

    if (error instanceof Error && WEB_SPEECH_MISSING.has(error.message)) {
        return "missing";
    }

    return "other";
};

const startWebSpeech = (callbacks: ListenCallbacks, lang: string | undefined): ListenSession => {
    const SpeechRecognitionConstructor = getSpeechRecognition();

    if (!SpeechRecognitionConstructor) {
        throw new ListenUnsupportedError();
    }

    const recognition = new SpeechRecognitionConstructor();
    let stopped = false;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang || navigator.language || "en-US";

    recognition.onresult = (event) => {
        let interim = "";

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const transcript = result?.[0]?.transcript ?? "";

            if (result?.isFinal) {
                callbacks.onCommitted(transcript);
            } else {
                interim += transcript;
            }
        }

        callbacks.onPartial(interim);
    };

    recognition.addEventListener("error", (event) => {
        // `no-speech` / `aborted` end the session quietly; `onend` restarts it.
        if (event.error === "aborted" || event.error === "no-speech") {
            return;
        }

        stopped = true;
        callbacks.onError(event.error);
    });

    recognition.onend = () => {
        if (!stopped) {
            callbacks.onEnd();
        }
    };

    recognition.start();

    return {
        stop: async () => {
            stopped = true;
            recognition.stop();
        },
    };
};

/**
 * How long a session may hear nothing before it ends as a quiet end
 * (`onEnd`). Scribe's VAD never ends a silent session, and not every Web Speech
 * implementation does either; the caller counts quiet ends and gives up after a
 * few (`MAX_QUIET_RESTARTS`), so without this a silent room held the loop in
 * `listening` forever. Longer than Chrome's own silence timeout, which wins there.
 */
export const NO_SPEECH_TIMEOUT_MS = 10_000;

/**
 * Wraps one engine session so it ends EXACTLY once: by the engine (`onEnd`),
 * by an error, by `NO_SPEECH_TIMEOUT_MS` without any text, or by the caller's
 * `stop()` (which reports nothing). The timer starts once the engine is up — a
 * microphone permission prompt is not silence — and restarts on every
 * non-blank transcript.
 */
export const superviseQuiet = async (
    start: (callbacks: ListenCallbacks) => Promise<ListenSession>,
    callbacks: ListenCallbacks,
    timeoutMs: number = NO_SPEECH_TIMEOUT_MS,
): Promise<ListenSession> => {
    let ended = false;
    let session: ListenSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): boolean => {
        clearTimeout(timer);

        if (ended) {
            return false;
        }

        ended = true;

        return true;
    };

    const onEnd = (): void => {
        if (finish()) {
            callbacks.onEnd();
        }
    };

    const arm = (): void => {
        clearTimeout(timer);

        if (!ended) {
            timer = setTimeout(() => {
                void session?.stop().catch(() => undefined);
                onEnd();
            }, timeoutMs);
        }
    };

    const heard = (text: string): void => {
        if (text.trim()) {
            arm();
        }
    };

    session = await start({
        onCommitted: (text) => {
            heard(text);
            callbacks.onCommitted(text);
        },
        onEnd,
        onError: (message) => {
            if (finish()) {
                callbacks.onError(message);
            }
        },
        onPartial: (text) => {
            heard(text);
            callbacks.onPartial(text);
        },
    });

    arm();

    const started = session;

    return {
        stop: async () => {
            finish();
            await started.stop();
        },
    };
};

/**
 * Starts listening. Throws (a `DOMException` for a denied or missing
 * microphone, {@link ListenUnsupportedError} without any engine).
 */
export const startListening = async (callbacks: ListenCallbacks, lang?: string): Promise<ListenSession> => {
    // Created before any `await` — see `startScribeSession`.
    const audioContext = canCaptureRealtime() ? new AudioContext() : null;
    const token = audioContext ? await fetchScribeToken() : null;

    if (audioContext && token) {
        return await superviseQuiet(
            async (supervised): Promise<ScribeSession> =>
                await startScribeSession({
                    audioContext,
                    callbacks: { onCommitted: supervised.onCommitted, onEnd: supervised.onEnd, onError: supervised.onError, onPartial: supervised.onPartial },
                    token,
                }),
            callbacks,
        );
    }

    void audioContext?.close().catch(() => undefined);

    return await superviseQuiet(async (supervised) => startWebSpeech(supervised, lang), callbacks);
};
