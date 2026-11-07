import type { ExpoSpeechRecognitionErrorCode, ExpoSpeechRecognitionOptions } from "expo-speech-recognition";

import { settleQuietly } from "../offline/quietly";
import type { VoicePhase } from "./voice-input";
import {
    MAX_CLIP_MS,
    MIC_BUSY_MESSAGE,
    MIC_DENIED_MESSAGE,
    MIN_CLIP_MS,
    NOTHING_HEARD_MESSAGE,
    RECORDING_FAILED_MESSAGE,
    TOO_SHORT_MESSAGE,
} from "./voice-input";

export const ON_DEVICE_UNAVAILABLE_MESSAGE
    = 'This phone cannot turn speech into text on the device. Nothing was sent. Type your message, or turn off "Transcribe on this device" in Settings.';
const ON_DEVICE_LANGUAGE_MESSAGE
    = "This phone cannot turn speech in its language into text on the device, or the language is not downloaded yet. Nothing was sent. Type your message.";
const ON_DEVICE_FAILED_MESSAGE = "The recording could not be turned into text on this phone. Nothing was sent. Try again, or type your message.";

/** The recognizer stops on its own after this when asked to stop; a native stop that never ends must not hold the button. */
export const END_DEADLINE_MS = 10_000;

/** The slice of the speech recognition module this uses, so tests can fake it. */
export interface OnDeviceRecognizer {
    abort: () => void;
    getMicrophonePermissionsAsync: () => Promise<{ granted: boolean }>;
    requestMicrophonePermissionsAsync: () => Promise<{ granted: boolean }>;
    start: (options: ExpoSpeechRecognitionOptions) => void;
    stop: () => void;
    supportsOnDeviceRecognition: () => boolean;
}

export type OnDeviceEvent
    = { code: ExpoSpeechRecognitionErrorCode; type: "error" } | { isFinal: boolean; transcript: string; type: "result" } | { type: "end" };

/**
 * Whether recognition can be held to the phone. Below Android 13 an on-device request only prefers offline and may
 * still use the network, so it counts as unavailable. iOS fails such a request instead (see the module's patch).
 */
export const isOnDeviceAvailable = (
    platform: { OS: string; Version: number | string },
    recognizer: Pick<OnDeviceRecognizer, "supportsOnDeviceRecognition">,
): boolean => {
    if (platform.OS !== "ios" && !(platform.OS === "android" && Number(platform.Version) >= 33)) {
        return false;
    }

    try {
        return recognizer.supportsOnDeviceRecognition();
    } catch {
        return false;
    }
};

const ERROR_MESSAGES: Partial<Record<ExpoSpeechRecognitionErrorCode, string>> = {
    "audio-capture": RECORDING_FAILED_MESSAGE,
    interrupted: RECORDING_FAILED_MESSAGE,
    "language-not-supported": ON_DEVICE_LANGUAGE_MESSAGE,
    "no-speech": NOTHING_HEARD_MESSAGE,
    "not-allowed": MIC_DENIED_MESSAGE,
    "service-not-allowed": ON_DEVICE_UNAVAILABLE_MESSAGE,
    "speech-timeout": NOTHING_HEARD_MESSAGE,
};

/** The phone's language as a BCP-47 tag without extensions, e.g. "de-DE". */
export const speechLocale = (locale: string): string => locale.split("-u-", 1)[0] ?? locale;

/** Who is listening, on any screen: the recognizer is one per app, and its events reach every screen that listens. */
export const createRecognizerLock = () => {
    let owner: symbol | undefined;

    return {
        claim: (token: symbol): boolean => {
            if (owner !== undefined) {
                return false;
            }

            owner = token;

            return true;
        },
        isHeldBy: (token: symbol): boolean => owner === token,
        isTaken: (): boolean => owner !== undefined,
        release: (token: symbol): void => {
            if (owner === token) {
                owner = undefined;
            }
        },
    };
};

export type RecognizerLock = ReturnType<typeof createRecognizerLock>;

/**
 * Hold to listen, release to get the text, all on the phone. Nothing here can reach the cloud path: a phone that cannot
 * recognize on the device gets a message, never a recording sent elsewhere. `handle` takes the recognizer's events.
 */
export const createOnDeviceSession = ({
    lang,
    lock,
    now,
    onError,
    onPhase,
    onText,
    platform,
    recognizer,
}: {
    lang: string;
    lock: RecognizerLock;
    now: () => number;
    onError: (message: string | undefined) => void;
    onPhase: (phase: VoicePhase) => void;
    onText: (text: string) => void;
    platform: { OS: string; Version: number | string };
    recognizer: OnDeviceRecognizer;
}) => {
    const token = Symbol("on-device press");
    let isAttached = true;
    let isBusy = false;
    let isHeld = false;
    let isStopping = false;
    let startedAt = 0;
    let finals: string[] = [];
    let failure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isListening = (): boolean => lock.isHeldBy(token);

    const release = (): void => {
        clearTimeout(timer);
        lock.release(token);
        isBusy = false;
        isStopping = false;
        onPhase("idle");
    };

    const finish = async (): Promise<void> => {
        isHeld = false;

        if (isStopping || !isListening()) {
            return;
        }

        isStopping = true;
        clearTimeout(timer);

        if (now() - startedAt < MIN_CLIP_MS) {
            failure = TOO_SHORT_MESSAGE;
            recognizer.abort();
        } else {
            onPhase("transcribing");
            recognizer.stop();
        }

        timer = setTimeout(() => {
            onError(failure ?? ON_DEVICE_FAILED_MESSAGE);
            release();
        }, END_DEADLINE_MS);
    };

    const start = async (): Promise<void> => {
        if (isBusy) {
            return;
        }

        isBusy = true;
        isHeld = true;
        onError(undefined);

        if (!isOnDeviceAvailable(platform, recognizer)) {
            onError(ON_DEVICE_UNAVAILABLE_MESSAGE);
            isBusy = false;

            return;
        }

        try {
            // Asked only when not yet granted: a first prompt takes the finger off the button, which is no "too short".
            const current = await recognizer.getMicrophonePermissionsAsync();
            const hadPermission = current.granted;
            const permission = hadPermission ? current : await recognizer.requestMicrophonePermissionsAsync();
            const isGranted = permission.granted;

            if (!isGranted || !isHeld || !isAttached || lock.isTaken()) {
                if (!isGranted) {
                    onError(MIC_DENIED_MESSAGE);
                } else if (lock.isTaken()) {
                    onError(MIC_BUSY_MESSAGE);
                } else if (hadPermission && isAttached) {
                    onError(TOO_SHORT_MESSAGE);
                }

                isBusy = false;

                return;
            }

            lock.claim(token);
            finals = [];
            failure = undefined;
            // Never `requiresOnDeviceRecognition: false`, and no service package: the system's on-device recognizer only.
            recognizer.start({ addsPunctuation: true, continuous: true, interimResults: false, lang, requiresOnDeviceRecognition: true });
            startedAt = now();
            onPhase("recording");
            timer = setTimeout(() => {
                settleQuietly(finish());
            }, MAX_CLIP_MS);
        } catch (startError) {
            console.warn("Could not start on-device speech recognition.", startError);
            onError(ON_DEVICE_FAILED_MESSAGE);
            release();
        }
    };

    const handle = (event: OnDeviceEvent): void => {
        // Another screen's recognition, or this one already given up on.
        if (!isListening()) {
            return;
        }

        if (event.type === "result") {
            if (event.isFinal && event.transcript.trim() !== "") {
                finals.push(event.transcript.trim());
            }

            return;
        }

        if (event.type === "error") {
            // An abort is this session's own doing, and its reason is already set.
            if (event.code !== "aborted") {
                failure ??= ERROR_MESSAGES[event.code] ?? ON_DEVICE_FAILED_MESSAGE;
            }

            return;
        }

        const text = finals.join(" ");

        if (failure !== undefined) {
            onError(failure);
        } else if (text === "") {
            onError(NOTHING_HEARD_MESSAGE);
        } else {
            onText(text);
        }

        release();
    };

    return {
        /** The screen is (again) on show. */
        attach: (): void => {
            isAttached = true;
        },
        /** The screen is gone: what is being heard is dropped, and no text or message comes from it. */
        detach: (): void => {
            isAttached = false;

            if (isListening()) {
                recognizer.abort();
                clearTimeout(timer);
                lock.release(token);
            }

            isBusy = false;
            isStopping = false;
        },
        finish,
        handle,
        start,
    };
};

export type OnDeviceSession = ReturnType<typeof createOnDeviceSession>;
