/**
 * Hands-free voice mode as a pure state machine.
 *
 * The loop is `idle → listening → sending → waiting → speaking → listening`.
 * `STOP` ends it from any phase, and an `ERROR` from any active phase falls
 * back to `idle` carrying the message to announce. Every event that does not
 * apply to the current phase is ignored and returns the SAME state object, so
 * a late callback from a torn-down dictation or speech session cannot move the
 * loop.
 *
 * No React, no browser APIs and no lingui here: the controller maps phases to
 * side effects, the button maps {@link VoiceModeAnnouncement}s to words.
 */

export type VoiceModePhase = "idle" | "listening" | "sending" | "speaking" | "waiting";

/** What the mic button shows: sending and waiting both read as "thinking". */
export type VoiceModeIndicator = "idle" | "listening" | "speaking" | "thinking";

export interface VoiceModeState {
    /** Set when the last run ended with an error; cleared on the next start. */
    error: string | null;
    phase: VoiceModePhase;
}

export type VoiceModeEvent =
    /** The user switched hands-free mode on. */
    | { type: "START" }
    /** The listener heard a finished utterance. Blank text keeps listening. */
    | { text: string; type: "UTTERANCE" }
    /** The utterance was handed to the chat. */
    | { type: "SENT" }
    /** The assistant's reply finished streaming. Blank (nothing speakable) goes straight back to listening. */
    | { text: string; type: "REPLY_FINISHED" }
    /** The reply finished (or failed) speaking. */
    | { type: "SPEECH_ENDED" }
    /** Toggle, Esc, or the composer going away. */
    | { type: "STOP" }
    | { message: string; type: "ERROR" };

export type VoiceModeAnnouncement =
    { kind: "error"; message: string } | { kind: "listening" } | { kind: "speaking" } | { kind: "stopped" } | { kind: "thinking" };

export const INITIAL_VOICE_MODE_STATE: VoiceModeState = { error: null, phase: "idle" };

const withPhase = (phase: VoiceModePhase): VoiceModeState => {
    return { error: null, phase };
};

export const voiceModeReducer = (state: VoiceModeState, event: VoiceModeEvent): VoiceModeState => {
    if (event.type === "STOP") {
        return state.phase === "idle" ? state : withPhase("idle");
    }

    if (event.type === "ERROR") {
        return state.phase === "idle" ? state : { error: event.message, phase: "idle" };
    }

    switch (state.phase) {
        case "idle": {
            return event.type === "START" ? withPhase("listening") : state;
        }
        case "listening": {
            return event.type === "UTTERANCE" && event.text.trim() ? withPhase("sending") : state;
        }
        case "sending": {
            return event.type === "SENT" ? withPhase("waiting") : state;
        }
        case "speaking": {
            return event.type === "SPEECH_ENDED" ? withPhase("listening") : state;
        }
        case "waiting": {
            if (event.type !== "REPLY_FINISHED") {
                return state;
            }

            return withPhase(event.text.trim() ? "speaking" : "listening");
        }
        default: {
            return state;
        }
    }
};

export const indicatorOf = (phase: VoiceModePhase): VoiceModeIndicator => {
    if (phase === "sending" || phase === "waiting") {
        return "thinking";
    }

    return phase;
};

/**
 * What a screen reader should hear after a transition, or `null` when the
 * visible state did not change (`sending → waiting` is "thinking" both ways).
 */
export const announcementFor = (previous: VoiceModeState, next: VoiceModeState): VoiceModeAnnouncement | null => {
    if (previous === next) {
        return null;
    }

    if (next.phase === "idle") {
        return next.error ? { kind: "error", message: next.error } : { kind: "stopped" };
    }

    const indicator = indicatorOf(next.phase);

    if (indicator === indicatorOf(previous.phase) || indicator === "idle") {
        return null;
    }

    return { kind: indicator };
};
