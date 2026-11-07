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
    getSupportedLocales: (options: { androidRecognitionServicePackage?: string }) => Promise<{ installedLocales: string[]; locales: string[] }>;
    requestMicrophonePermissionsAsync: () => Promise<{ granted: boolean }>;
    start: (options: ExpoSpeechRecognitionOptions) => void;
    stop: () => void;
    supportsOnDeviceRecognition: () => boolean;
}

export type OnDeviceEvent
    = | { code: ExpoSpeechRecognitionErrorCode; type: "error" }
        | { isFinal: boolean; transcript: string; type: "result" }
        | { type: "end" }
        | { type: "start" };

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

const normalized = (locale: string): string => locale.replaceAll("_", "-").toLowerCase();

/**
 * The recognizer's locale for the phone's language: the same tag, else the first one of the same language. The phone's
 * tag mixes language and region ("en-DE"), which the recognizer may not list. With no match, the phone's tag is kept.
 */
export const pickSpeechLocale = (wanted: string, available: string[]): string => {
    const tag = normalized(wanted);
    const language = tag.split("-", 1)[0] ?? tag;

    return available.find((locale) => normalized(locale) === tag) ?? available.find((locale) => normalized(locale).split("-", 1)[0] === language) ?? wanted;
};

/** How long a press waits for the recognizer's language list. */
const LOCALE_DEADLINE_MS = 3000;

/** The locales the on-device recognizer can use: the installed ones where the platform lists them apart. */
const speechLocales = async (recognizer: OnDeviceRecognizer): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        // Some Android recognition services never answer this: the press goes on with the phone's own tag.
        const { installedLocales, locales } = await Promise.race([
            recognizer.getSupportedLocales({}),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error("The recognizer did not list its languages in time."));
                }, LOCALE_DEADLINE_MS);
            }),
        ]);

        return installedLocales.length > 0 ? installedLocales : locales;
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
};

/** How long an aborted recognition holds the recognizer at most while its end is awaited. */
export const DRAIN_MS = 2000;

/** Who is listening, on any screen: the recognizer is one per app, and its events reach every screen that listens. */
export const createRecognizerLock = () => {
    // An aborted recognition whose end has not arrived yet: no screen owns it, and no press may start meanwhile.
    const draining = Symbol("draining");
    let owner: symbol | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    return {
        claim: (token: symbol): boolean => {
            if (owner !== undefined) {
                return false;
            }

            owner = token;

            return true;
        },
        /** `token`'s recognition was aborted: held until its end, so that end never reaches a newer press. */
        drain: (token: symbol): void => {
            if (owner !== token) {
                return;
            }

            owner = draining;
            clearTimeout(drainTimer);
            drainTimer = setTimeout(() => {
                if (owner === draining) {
                    owner = undefined;
                }
            }, DRAIN_MS);
        },
        /** Any recognition's end, heard app-wide: an aborted one is now over. */
        ended: (): void => {
            if (owner !== draining) {
                return;
            }

            owner = undefined;
            clearTimeout(drainTimer);
        },
        isHeldBy: (token: symbol): boolean => owner === token,
        /** Whether a recognition that just started belongs to no press: one cut off before it was running. */
        isStray: (): boolean => owner === undefined || owner === draining,
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
    // The recognizer reported this recognition running. Until then a stop or abort would miss it (iOS starts it later).
    let hasStarted = false;
    // A real error came for this recognition, so an end before its start is its own and not an earlier one's.
    let hasErrored = false;
    let isTooShort = false;
    let startedAt = 0;
    let finals: string[] = [];
    let failure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isListening = (): boolean => lock.isHeldBy(token);

    /** A native stop or abort that throws must not skip the cleanup after it. */
    const didNativeCall = (call: () => void): boolean => {
        try {
            call();

            return true;
        } catch (callError) {
            console.warn("The speech recognizer refused a call.", callError);

            return false;
        }
    };

    /** Cuts the recognition off; the recognizer is held until its end arrives (see `drain`). */
    const abandon = (): void => {
        clearTimeout(timer);
        didNativeCall(() => {
            recognizer.abort();
        });
        lock.drain(token);
        isBusy = false;
        isStopping = false;
    };

    /** The recognition is over. The lock is let go only now, so its late events never reach a newer press. */
    const release = (): void => {
        clearTimeout(timer);
        lock.release(token);
        isBusy = false;
        isStopping = false;

        if (isAttached) {
            onPhase("idle");
        }
    };

    /** A recognition that never ends must not hold the recognizer: it is cut off, and the lock let go anyway. */
    const giveUpAfterDeadline = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (isAttached) {
                onError(failure ?? ON_DEVICE_FAILED_MESSAGE);
                onPhase("idle");
            }

            abandon();
        }, END_DEADLINE_MS);
    };

    /** Asks the running recognition to end: an abort for a press too short to keep, else a stop that yields its text. */
    const askToEnd = (): void => {
        const isAsked = didNativeCall(() => {
            if (isTooShort) {
                recognizer.abort();
            } else {
                recognizer.stop();
            }
        });

        if (isAsked) {
            giveUpAfterDeadline();
        } else {
            onError(failure ?? ON_DEVICE_FAILED_MESSAGE);
            onPhase("idle");
            abandon();
        }
    };

    const finish = async (): Promise<void> => {
        isHeld = false;

        if (isStopping || !isListening()) {
            return;
        }

        isStopping = true;
        isTooShort = now() - startedAt < MIN_CLIP_MS;

        if (isTooShort) {
            failure = TOO_SHORT_MESSAGE;
        } else {
            onPhase("transcribing");
        }

        if (hasStarted) {
            askToEnd();
        } else {
            // Asked once the recognizer reports it running (see `handle`); the deadline covers a start that never comes.
            giveUpAfterDeadline();
        }
    };

    const start = async (): Promise<void> => {
        if (isBusy) {
            // A press while the previous one is still starting takes it over, rather than being dropped with it.
            if (!isListening()) {
                isHeld = true;
            }

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
            const locale = isGranted ? pickSpeechLocale(lang, await speechLocales(recognizer)) : lang;

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
            hasStarted = false;
            hasErrored = false;
            // Never `requiresOnDeviceRecognition: false`, and no service package: the system's on-device recognizer only.
            recognizer.start({ addsPunctuation: true, continuous: true, interimResults: false, lang: locale, requiresOnDeviceRecognition: true });
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

    /** This recognition ended: its text goes to the draft, or its failure to the composer. */
    const complete = (): void => {
        const text = finals.join(" ");

        if (!isAttached) {
            // The screen is gone: nobody to tell.
        } else if (failure !== undefined) {
            onError(failure);
        } else if (text === "") {
            onError(NOTHING_HEARD_MESSAGE);
        } else {
            onText(text);
        }

        release();
    };

    const handle = (event: OnDeviceEvent): void => {
        // Another screen's recognition, or this one already given up on.
        if (!isListening()) {
            return;
        }

        if (event.type === "start") {
            hasStarted = true;

            if (isStopping) {
                askToEnd();
            }

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
                hasErrored = true;
                failure ??= ERROR_MESSAGES[event.code] ?? ON_DEVICE_FAILED_MESSAGE;
            }

            return;
        }

        // An end before this recognition started, with no error of its own, is an earlier recognition's (iOS sends one
        // when a new start resets the recognizer).
        if (hasStarted || hasErrored) {
            complete();
        }
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
                abandon();
            }
        },
        finish,
        handle,
        start,
    };
};

export type OnDeviceSession = ReturnType<typeof createOnDeviceSession>;
