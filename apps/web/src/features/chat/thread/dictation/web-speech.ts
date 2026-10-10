/**
 * Minimal Web Speech API surface, shared by composer dictation and hands-free
 * voice mode. `lib.dom` ships `SpeechRecognitionEvent` but not
 * `SpeechRecognition` itself, and the API is still vendor-prefixed in Chromium,
 * so the constructor has to be described here and looked up off `globalThis`.
 */

export interface SpeechRecognitionAlternativeLike {
    transcript: string;
}

export interface SpeechRecognitionResultLike {
    isFinal: boolean;
    readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionResultListLike {
    length: number;
    readonly [index: number]: SpeechRecognitionResultLike | undefined;
}

export interface SpeechRecognitionResultEventLike {
    resultIndex: number;
    results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
    error: string;
}

export interface SpeechRecognitionLike {
    addEventListener: (type: "error", listener: (event: SpeechRecognitionErrorEventLike) => void) => void;
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onend: (() => void) | null;
    onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
    start: () => void;
    stop: () => void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Check browser support for SpeechRecognition. */
export const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
    if (typeof globalThis === "undefined") {
        return null;
    }

    const speechGlobals = globalThis as unknown as {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

    return speechGlobals.SpeechRecognition ?? speechGlobals.webkitSpeechRecognition ?? null;
};

/** Whether this browser can run the Scribe client (microphone + AudioWorklet + WebSocket). */
export const canCaptureRealtime = (): boolean =>
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof globalThis.AudioWorkletNode === "function" &&
    typeof globalThis.WebSocket === "function";
