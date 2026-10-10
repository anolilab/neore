/**
 * When hands-free speech should stop asking for registry TTS, and which voices
 * that model offers. The speaker falls back to the browser voice on any failure
 * by itself; this only keeps a refused or exhausted TTS from being retried on
 * every reply (a wasted round trip before each fallback).
 */
import { DEFAULT_SPEECH_MODEL, GATEWAY_SPEECH_MODELS } from "@neore/ai/models";

/** The preset voices of the model voice mode speaks with (`voice_speech.synthesizeSpeech`). */
export const SPEECH_VOICES: ReadonlyArray<string> = GATEWAY_SPEECH_MODELS[DEFAULT_SPEECH_MODEL]?.voices ?? [];

/** The voice the model uses when none is chosen. */
export const DEFAULT_SPEECH_VOICE: string | undefined = GATEWAY_SPEECH_MODELS[DEFAULT_SPEECH_MODEL]?.defaultVoice;

/** Whether `voice` names a preset of the speech model (vs. a browser voice or language tag). */
export const isSpeechVoice = (voice: string | undefined): voice is string => voice !== undefined && SPEECH_VOICES.includes(voice.trim());

/** A rate limit that names no reset is retried after this long. */
const DEFAULT_PAUSE_MS = 60_000;

/**
 * How long to stop trying TTS after it failed with `error`: for the rest of the
 * page's life when it is refused (a guest, not configured), until the limit
 * resets when one is spent, and not at all after a one-off failure.
 */
export const ttsPauseMs = (error: unknown): number => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown; retryAfter?: unknown } };
    const codes = new Set([code, data?.code]);

    if (codes.has("FORBIDDEN") || codes.has("NOT_IMPLEMENTED") || codes.has("UNAUTHORIZED")) {
        return Infinity;
    }

    if (codes.has("TOO_MANY_REQUESTS")) {
        return typeof data?.retryAfter === "number" && data.retryAfter > 0 ? data.retryAfter : DEFAULT_PAUSE_MS;
    }

    return 0;
};

/** `"Sweet_Girl_2"` → `"Sweet Girl 2"`: a preset id as the voice pickers show it. */
export const speechVoiceLabel = (voice: string): string => voice.replaceAll("_", " ");
