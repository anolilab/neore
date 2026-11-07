import type { RecordingOptions } from "expo-audio";
import { AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";

import { getClient } from "@/lib/lunora";
import { settleQuietly } from "@/offline/quietly";

import {
    MAX_CLIP_MS,
    MIC_DENIED_MESSAGE,
    MIN_CLIP_MS,
    NOTHING_HEARD_MESSAGE,
    RECORDING_FAILED_MESSAGE,
    TOO_SHORT_MESSAGE,
    transcribeClip,
    voiceErrorMessage,
} from "./voice-input";

/** Speech needs little: 16 kHz mono AAC at 32 kbit/s keeps a minute near 240 KB. */
const RECORDING_OPTIONS: RecordingOptions = {
    android: { audioEncoder: "aac", outputFormat: "mpeg4" },
    bitRate: 32_000,
    extension: ".m4a",
    ios: { audioQuality: AudioQuality.LOW, outputFormat: IOSOutputFormat.MPEG4AAC },
    numberOfChannels: 1,
    sampleRate: 16_000,
    web: {},
};

export type VoicePhase = "idle" | "recording" | "transcribing";

/**
 * The clip is a temporary file: it is deleted once it has been read, whatever happened. The audio is never kept.
 * Returns whether the file is gone, so a failed delete can be tried again.
 */
const isDiscarded = (uri: string | undefined): boolean => {
    if (!uri) {
        return true;
    }

    try {
        const file = new File(uri);

        if (file.exists) {
            file.delete();
        }

        return true;
    } catch (error) {
        console.warn("Could not delete the voice clip.", error);

        return false;
    }
};

/**
 * Hold to record, release to transcribe. `onText` gets the words to put into the draft; nothing is ever sent as a
 * message from here. `error` is voice input's own message for the composer, apart from the screen's send errors, so a
 * press never clears a send failure.
 */
export const useVoiceInput = ({ onText }: { onText: (text: string) => void }) => {
    const recorder = useAudioRecorder(RECORDING_OPTIONS);
    const [phase, setPhase] = useState<VoicePhase>("idle");
    const [error, setError] = useState<string | undefined>(undefined);
    // Whether the finger is still on the button: a release during the permission prompt or the recorder's start records nothing.
    const isHeld = useRef(false);
    // From a press until its clip is done with: a second press meanwhile is ignored, so two starts never share the recorder.
    const isBusy = useRef(false);
    const isRecording = useRef(false);
    const isMounted = useRef(true);
    // Where the clip is written, known once the recorder is prepared, so it can be deleted whatever happens after.
    const clipUri = useRef<string | undefined>(undefined);
    const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const callbacks = useRef({ onText });

    callbacks.current = { onText };

    const report = useCallback((message: string) => {
        if (isMounted.current) {
            setError(message);
        }
    }, []);

    /** Stops the recorder and returns the clip's path; the caller deletes it. A failed stop still hands the path back. */
    const stopRecording = useCallback(async (): Promise<string | undefined> => {
        isRecording.current = false;

        try {
            await recorder.stop();
        } finally {
            settleQuietly(setAudioModeAsync({ allowsRecording: false }));
        }

        return clipUri.current ?? recorder.uri ?? undefined;
    }, [recorder]);

    const finish = useCallback(async () => {
        isHeld.current = false;
        clearTimeout(stopTimer.current);

        if (!isRecording.current) {
            return;
        }

        setPhase("transcribing");

        let uri: string | undefined = clipUri.current;

        try {
            const { durationMillis } = recorder.getStatus();

            uri = await stopRecording();

            if (!uri) {
                report(RECORDING_FAILED_MESSAGE);

                return;
            }

            if (durationMillis < MIN_CLIP_MS) {
                report(TOO_SHORT_MESSAGE);

                return;
            }

            const audio = await new File(uri).base64();

            // A delete that failed here is tried once more below.
            if (isDiscarded(uri)) {
                uri = undefined;
            }

            // Left the screen meanwhile: nobody would see the text, so the paid call is not made.
            if (!isMounted.current) {
                return;
            }

            const text = await transcribeClip(getClient(), { audio, durationMs: Math.min(durationMillis, MAX_CLIP_MS) });

            if (isMounted.current) {
                if (text.trim() === "") {
                    report(NOTHING_HEARD_MESSAGE);
                } else {
                    callbacks.current.onText(text);
                }
            }
        } catch (transcribeError) {
            report(voiceErrorMessage(transcribeError));
        } finally {
            isDiscarded(uri);
            clipUri.current = undefined;
            isBusy.current = false;

            if (isMounted.current) {
                setPhase("idle");
            }
        }
    }, [recorder, report, stopRecording]);

    const start = useCallback(async () => {
        if (isBusy.current) {
            return;
        }

        isBusy.current = true;
        isHeld.current = true;
        setError(undefined);

        try {
            const permission = await requestRecordingPermissionsAsync();

            if (!permission.granted) {
                report(MIC_DENIED_MESSAGE);
                isBusy.current = false;

                return;
            }

            await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
            await recorder.prepareToRecordAsync();
            clipUri.current = recorder.uri ?? undefined;

            // Released while the recorder was starting (or while the first permission prompt was up): nothing to record.
            if (!isHeld.current || !isMounted.current) {
                settleQuietly(setAudioModeAsync({ allowsRecording: false }));
                isDiscarded(clipUri.current);
                clipUri.current = undefined;
                isBusy.current = false;

                return;
            }

            recorder.record();
            isRecording.current = true;
            setPhase("recording");
            stopTimer.current = setTimeout(() => {
                settleQuietly(finish());
            }, MAX_CLIP_MS);
        } catch (startError) {
            console.warn("Could not start the voice recording.", startError);
            settleQuietly(setAudioModeAsync({ allowsRecording: false }));
            report(RECORDING_FAILED_MESSAGE);
            isDiscarded(clipUri.current);
            clipUri.current = undefined;
            isBusy.current = false;
        }
    }, [finish, recorder, report]);

    // Leaving the screen mid-recording: stop, and delete what was recorded even when the released recorder cannot stop.
    useEffect(() => {
        isMounted.current = true;

        return () => {
            isMounted.current = false;
            clearTimeout(stopTimer.current);

            if (isRecording.current) {
                const uri = clipUri.current;

                settleQuietly(async () => {
                    try {
                        await stopRecording();
                    } finally {
                        isDiscarded(uri);
                    }
                });
            }
        };
    }, [stopRecording]);

    return { error, finish, phase, start };
};
