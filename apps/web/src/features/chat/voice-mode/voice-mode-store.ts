/**
 * Hands-free voice mode state, shared by the composer toggle (eager) and the
 * loop controller (lazy). Module-level so the loop survives the composer
 * remounting when a first message turns `/chat` into `/chat/$threadId`.
 */

import { create } from "zustand";

import type { VoiceModeAnnouncement, VoiceModeEvent, VoiceModeState } from "./voice-mode-machine";
import { announcementFor, INITIAL_VOICE_MODE_STATE, voiceModeReducer } from "./voice-mode-machine";

interface VoiceModeStore {
    /** The latest thing to announce, with a counter so a repeat still re-renders the live region. */
    announcement: { id: number; value: VoiceModeAnnouncement } | null;

    /**
     * The newest assistant message when the utterance was sent — the reply to
     * wait for is the first finished assistant message after it.
     */
    baselineReplyId: string | null;

    /**
     * Claims the loop for a toggle (`force` on START, so the one clicked wins);
     * without `force` only a vacant claim is taken. Only the owner mounts the
     * controller and the live region: two composers on one page (the landing
     * hero and its sticky bar) each mounting one ran two microphones and sent
     * every utterance twice.
     */
    claimController: (id: string, force?: boolean) => void;

    /** The toggle that owns the loop, or `null` while none does (its composer unmounted). */
    controllerOwner: string | null;
    /** Called when a toggle unmounts; a remaining (or remounted) toggle then claims the vacancy. */
    releaseController: (id: string) => void;
    send: (event: VoiceModeEvent) => void;
    setBaselineReplyId: (id: string | null) => void;
    state: VoiceModeState;
}

export const useVoiceModeStore = create<VoiceModeStore>((set, get) => {
    return {
        announcement: null,
        baselineReplyId: null,
        claimController: (id, force = false) => {
            const owner = get().controllerOwner;

            if (owner !== id && (force || owner === null)) {
                set({ controllerOwner: id });
            }
        },
        controllerOwner: null,
        releaseController: (id) => {
            if (get().controllerOwner === id) {
                set({ controllerOwner: null });
            }
        },
        send: (event) => {
            const previous = get().state;
            const next = voiceModeReducer(previous, event);

            if (next === previous) {
                return;
            }

            const value = announcementFor(previous, next);
            const counter = get().announcement?.id ?? 0;

            set({ state: next, ...(value && { announcement: { id: counter + 1, value } }) });
        },
        setBaselineReplyId: (id) => set({ baselineReplyId: id }),
        state: INITIAL_VOICE_MODE_STATE,
    };
});

export const sendVoiceModeEvent = (event: VoiceModeEvent): void => useVoiceModeStore.getState().send(event);
