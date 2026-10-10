import { describe, expect, it } from "vitest";

import type { VoiceModeEvent, VoiceModePhase, VoiceModeState } from "./voice-mode-machine";
import { announcementFor, indicatorOf, INITIAL_VOICE_MODE_STATE, voiceModeReducer } from "./voice-mode-machine";

const run = (events: VoiceModeEvent[], from: VoiceModeState = INITIAL_VOICE_MODE_STATE): VoiceModeState => {
    let state = from;

    for (const event of events) {
        state = voiceModeReducer(state, event);
    }

    return state;
};

const at = (phase: VoiceModePhase): VoiceModeState => {
    return { error: null, phase };
};

describe(voiceModeReducer, () => {
    it("walks the whole loop: idle → listening → sending → waiting → speaking → listening", () => {
        const phases: VoiceModePhase[] = [];
        let state = INITIAL_VOICE_MODE_STATE;

        for (const event of [
            { type: "START" },
            { text: "hello", type: "UTTERANCE" },
            { type: "SENT" },
            { text: "Hi there", type: "REPLY_FINISHED" },
            { type: "SPEECH_ENDED" },
        ] satisfies VoiceModeEvent[]) {
            state = voiceModeReducer(state, event);
            phases.push(state.phase);
        }

        expect(phases).toStrictEqual(["listening", "sending", "waiting", "speaking", "listening"]);
    });

    it("keeps listening on a blank utterance", () => {
        const listening = at("listening");

        expect(voiceModeReducer(listening, { text: " ".repeat(3), type: "UTTERANCE" })).toBe(listening);
    });

    it("goes straight back to listening when the reply has nothing to speak", () => {
        expect(run([{ text: "", type: "REPLY_FINISHED" }], at("waiting")).phase).toBe("listening");
    });

    it.each<VoiceModePhase>(["listening", "sending", "waiting", "speaking"])("stops from %s", (phase) => {
        expect(voiceModeReducer(at(phase), { type: "STOP" })).toStrictEqual({ error: null, phase: "idle" });
    });

    it.each<VoiceModePhase>(["listening", "sending", "waiting", "speaking"])("falls back to idle with the error from %s", (phase) => {
        expect(voiceModeReducer(at(phase), { message: "Microphone denied", type: "ERROR" })).toStrictEqual({ error: "Microphone denied", phase: "idle" });
    });

    it("ignores STOP and ERROR when already idle (same object)", () => {
        const idle = INITIAL_VOICE_MODE_STATE;

        expect(voiceModeReducer(idle, { type: "STOP" })).toBe(idle);
        expect(voiceModeReducer(idle, { message: "late", type: "ERROR" })).toBe(idle);
    });

    it("ignores events that do not belong to the current phase", () => {
        const waiting = at("waiting");

        expect(voiceModeReducer(waiting, { text: "late transcript", type: "UTTERANCE" })).toBe(waiting);
        expect(voiceModeReducer(waiting, { type: "SPEECH_ENDED" })).toBe(waiting);
        expect(voiceModeReducer(waiting, { type: "START" })).toBe(waiting);
        expect(voiceModeReducer(at("idle"), { type: "SENT" })).toStrictEqual(at("idle"));
    });

    it("clears a previous error on the next start", () => {
        expect(voiceModeReducer({ error: "boom", phase: "idle" }, { type: "START" })).toStrictEqual(at("listening"));
    });
});

describe(indicatorOf, () => {
    it("shows sending and waiting as thinking", () => {
        expect(indicatorOf("sending")).toBe("thinking");
        expect(indicatorOf("waiting")).toBe("thinking");
        expect(indicatorOf("listening")).toBe("listening");
        expect(indicatorOf("speaking")).toBe("speaking");
        expect(indicatorOf("idle")).toBe("idle");
    });
});

describe(announcementFor, () => {
    it("announces each visible state change", () => {
        expect(announcementFor(at("idle"), at("listening"))).toStrictEqual({ kind: "listening" });
        expect(announcementFor(at("listening"), at("sending"))).toStrictEqual({ kind: "thinking" });
        expect(announcementFor(at("waiting"), at("speaking"))).toStrictEqual({ kind: "speaking" });
        expect(announcementFor(at("speaking"), at("idle"))).toStrictEqual({ kind: "stopped" });
    });

    it("stays quiet when the indicator does not change", () => {
        expect(announcementFor(at("sending"), at("waiting"))).toBeNull();

        const same = at("listening");

        expect(announcementFor(same, same)).toBeNull();
    });

    it("announces the error when a run fails", () => {
        expect(announcementFor(at("listening"), { error: "No microphone found.", phase: "idle" })).toStrictEqual({
            kind: "error",
            message: "No microphone found.",
        });
    });
});
