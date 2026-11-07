import type { LunoraClient } from "@lunora/client";
import { api } from "@neore/backend/api";

import { isNetworkFailure } from "../offline/connectivity";

/** A press shorter than this is a tap, not a recording: nothing is sent. */
export const MIN_CLIP_MS = 400;

/** Recording stops here, as if the button were released. The server refuses longer clips. */
export const MAX_CLIP_MS = 60_000;

export const MIC_DENIED_MESSAGE = "Voice input needs the microphone. Allow it in the system settings, or type your message.";
export const TOO_SHORT_MESSAGE = "Hold the microphone button while you speak.";
export const NOTHING_HEARD_MESSAGE = "No speech was heard in the recording.";
export const RECORDING_FAILED_MESSAGE = "The recording could not be made. Try again, or type your message.";
const OFFLINE_MESSAGE = "Voice input needs a connection. Type your message, or try again when you are back online.";
const TRANSCRIBE_FAILED_MESSAGE = "The recording could not be turned into text. Try again, or type your message.";

/** The slice of the client this uses, so tests can fake it. */
export type VoiceClient = Pick<LunoraClient, "action">;

/** Above the server's own 50 s gateway deadline, so a call that stalls on the way still ends. */
export const TRANSCRIBE_TIMEOUT_MS = 70_000;

/**
 * Sends one clip to the server and returns its text. An action is never queued: offline, it fails at once. Actions
 * have no default timeout, so a stalled one is aborted here and reported as a failure.
 */
export const transcribeClip = async (client: VoiceClient, clip: { audio: string; durationMs: number }): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, TRANSCRIBE_TIMEOUT_MS);

    try {
        const { text } = await client.action(api.voice.transcription.transcribeClip, clip, { signal: controller.signal });

        return text;
    } finally {
        clearTimeout(timer);
    }
};

const ENDS_IN_SPACE = /\s$/u;

/** The transcript goes after what is already typed, separated by one space. */
export const appendTranscript = (draft: string, text: string): string => {
    const words = text.trim();

    if (words === "") {
        return draft;
    }

    return draft === "" || ENDS_IN_SPACE.test(draft) ? `${draft}${words}` : `${draft} ${words}`;
};

/** What to tell the person when a clip could not be turned into text. Their draft is kept either way. */
export const voiceErrorMessage = (error: unknown): string => {
    if (isNetworkFailure(error)) {
        return OFFLINE_MESSAGE;
    }

    const {
        code: topCode,
        data,
        message,
    } = (typeof error === "object" && error !== null ? error : {}) as {
        code?: unknown;
        data?: { code?: unknown } | null;
        message?: unknown;
    };
    // A Lunora error carries its code on `.code` or on `.data.code`.
    const code = typeof topCode === "string" ? topCode : data?.code;

    // The server's refusals for guests and spent allowances are written to be shown.
    if (typeof message === "string" && message !== "" && (code === "FORBIDDEN" || code === "TOO_MANY_REQUESTS")) {
        return message;
    }

    return TRANSCRIBE_FAILED_MESSAGE;
};
