import type { KeyValueStore } from "../chat/last-thread-storage";
import { TOO_SHORT_MESSAGE } from "./voice-input";

export const ON_DEVICE_KEY = "neore.mobile.on-device-dictation";

export const SETTING_UNREADABLE_MESSAGE
    = 'The voice input setting could not be read, so nothing was recorded. Switch "Transcribe on this device" in Settings to save your choice.';

/** Cloud transcription unless "Transcribe on this device" was switched on; there is no fallback between the two. */
export type DictationPath = "cloud" | "on-device";

/** Reads and writes "Transcribe on this device". Off by default. */
export const createDictationSetting = (store: Pick<KeyValueStore, "getItem" | "setItem">) => {
    return {
        /** Off when never chosen. A value this app never writes is unreadable, not off: it must not send audio away. */
        readOnDevice: async (): Promise<boolean> => {
            const value = await store.getItem(ON_DEVICE_KEY);

            if (value === null || value === "off") {
                return false;
            }

            if (value === "on") {
                return true;
            }

            throw new Error("Unrecognized on-device transcription setting.");
        },
        writeOnDevice: async (isOn: boolean): Promise<void> => {
            await store.setItem(ON_DEVICE_KEY, isOn ? "on" : "off");
        },
    };
};

export interface DictationEngine {
    finish: () => Promise<void>;
    start: () => Promise<void>;
}

/**
 * Sends each press to the path the setting names at that moment, read afresh so a change in Settings applies to the
 * next press. A setting that cannot be read records nothing: it is not known whether the audio may leave the phone.
 */
export const createDictationRouter = ({
    engine,
    onError,
    onPath,
    readOnDevice,
}: {
    engine: (path: DictationPath) => DictationEngine;
    onError: (message: string | undefined) => void;
    onPath: (path: DictationPath) => void;
    readOnDevice: () => Promise<boolean>;
}) => {
    let isReading = false;
    let isHeld = false;
    // The path whose press is in progress, so its release goes to it.
    let pressed: DictationPath | undefined;

    return {
        finish: async (): Promise<void> => {
            isHeld = false;

            const path = pressed;

            pressed = undefined;

            if (path !== undefined) {
                await engine(path).finish();
            }
        },
        start: async (): Promise<void> => {
            if (isReading) {
                return;
            }

            isReading = true;
            isHeld = true;
            onError(undefined);

            let path: DictationPath;

            try {
                path = await readOnDevice() ? "on-device" : "cloud";
            } catch (readError) {
                console.warn("Could not read the voice input setting.", readError);
                onError(SETTING_UNREADABLE_MESSAGE);

                return;
            } finally {
                isReading = false;
            }

            onPath(path);

            // Released before the setting was read: nothing to record.
            if (!isHeld) {
                onError(TOO_SHORT_MESSAGE);

                return;
            }

            pressed = path;
            await engine(path).start();
        },
    };
};
