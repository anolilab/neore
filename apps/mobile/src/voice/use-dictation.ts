import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import type { DictationPath } from "./dictation";
import { createDictationRouter } from "./dictation";
import { readOnDeviceDictation } from "./dictation-setting";
import { createOnDeviceSession, createRecognizerLock, speechLocale } from "./on-device";
import { useVoiceInput } from "./use-voice-input";
import type { VoicePhase } from "./voice-input";

/** One recognizer per app: a second screen's press is refused while this is taken. */
const recognizerLock = createRecognizerLock();
const appListeners: { subscriptions?: { remove: () => void }[] } = {};

/**
 * Heard app-wide, once: an end whose screen is gone still frees the recognizer, and a recognition that starts after its
 * press was cut off (iOS starts it later) is aborted, so the microphone never runs without an owner.
 */
const hearAppWide = (): void => {
    appListeners.subscriptions ??= [
        ExpoSpeechRecognitionModule.addListener("end", recognizerLock.ended),
        ExpoSpeechRecognitionModule.addListener("start", () => {
            if (recognizerLock.isStray()) {
                ExpoSpeechRecognitionModule.abort();
            }
        }),
    ];
};

/** Listens on the phone's own recognizer; the audio never leaves the phone. */
const useOnDeviceVoiceInput = ({ onText }: { onText: (text: string) => void }) => {
    const [phase, setPhase] = useState<VoicePhase>("idle");
    const [error, setError] = useState<string | undefined>(undefined);
    const callbacks = useRef({ onText });

    callbacks.current = { onText };

    const [session] = useState(() =>
        createOnDeviceSession({
            lang: speechLocale(new Intl.DateTimeFormat().resolvedOptions().locale),
            lock: recognizerLock,
            now: Date.now,
            onError: setError,
            onPhase: setPhase,
            onText: (text) => {
                callbacks.current.onText(text);
            },
            platform: Platform,
            recognizer: ExpoSpeechRecognitionModule,
        }),
    );

    useSpeechRecognitionEvent("start", () => {
        session.handle({ type: "start" });
    });
    useSpeechRecognitionEvent("result", (event) => {
        session.handle({ isFinal: event.isFinal, transcript: event.results[0]?.transcript ?? "", type: "result" });
    });
    useSpeechRecognitionEvent("error", (event) => {
        session.handle({ code: event.error, type: "error" });
    });
    useSpeechRecognitionEvent("end", () => {
        session.handle({ type: "end" });
    });

    useEffect(() => {
        hearAppWide();
        session.attach();

        return () => {
            session.detach();
        };
    }, [session]);

    return { error, finish: session.finish, phase, start: session.start };
};

/**
 * Hold to dictate into the draft, by the path "Transcribe on this device" names: the cloud by default, the phone's
 * own recognizer when it is on. A press on the on-device path that cannot be served shows why; it never goes to the cloud.
 */
export const useDictation = ({ onText }: { onText: (text: string) => void }) => {
    const cloud = useVoiceInput({ onText });
    const onDevice = useOnDeviceVoiceInput({ onText });
    const engines = useRef({ cloud, "on-device": onDevice });
    const [path, setPath] = useState<DictationPath>("cloud");
    const [error, setError] = useState<string | undefined>(undefined);

    engines.current = { cloud, "on-device": onDevice };

    const [router] = useState(() =>
        createDictationRouter({
            engine: (chosen) => engines.current[chosen],
            onError: setError,
            onPath: setPath,
            readOnDevice: readOnDeviceDictation,
        }),
    );
    const active = engines.current[path];

    return { error: error ?? active.error, finish: router.finish, phase: active.phase, start: router.start };
};
