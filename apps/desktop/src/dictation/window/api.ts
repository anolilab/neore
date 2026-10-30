import type { CaptureFailure } from "../channels";

/** What the dictation window's preload gives its page (`window.neoreDictation`): capture in, nothing out but audio and two signals. */
export interface DictationWindowApi {
    /** One chunk of 16 kHz mono signed 16-bit little-endian samples. */
    audio: (chunk: ArrayBuffer) => void;
    /** After a stop: the last chunk has been sent. */
    ended: () => void;
    failed: (failure: CaptureFailure) => void;
    /** The main process says the key was released. */
    onStop: (handler: () => void) => void;
}
