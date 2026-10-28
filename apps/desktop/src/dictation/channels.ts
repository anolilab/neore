/**
 * IPC names for the dictation window. Shared by the main process and the window's own preload.
 * The site never sees these: `index.ts` accepts them from the dictation window's page alone.
 */
export const DICTATION_CHANNEL = {
    /** Page → main: one chunk of 16 kHz mono signed 16-bit little-endian samples. */
    audio: "neore:dictation:audio",
    /** Page → main: after a stop, the last chunk has been sent. */
    ended: "neore:dictation:ended",
    /** Page → main: capture failed; the argument is one of `CAPTURE_FAILURES`. */
    failed: "neore:dictation:failed",
} as const;

/** Main → page. */
export const DICTATION_EVENT = {
    /** Stop the microphone, send the last chunk, then answer `ended`. */
    stop: "neore:dictation:stop",
} as const;

/** What the page may report about capture. The main process words the message, so the page picks from a closed list. */
export const CAPTURE_FAILURES = ["denied", "no-device", "error"] as const;

export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

export const SAMPLE_RATE = 16_000;
