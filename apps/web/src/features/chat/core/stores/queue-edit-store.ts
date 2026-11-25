import { create } from "zustand";

/**
 * The queued message whose text is open for editing in its chip, and the draft typed so far, per thread, and any send
 * the queue held because that head was being edited.
 *
 * Kept here, not in the chip, for two reasons: a chip that remounts (the reply ending, a re-key) keeps its unsaved
 * draft, and the queue's drain knows the head's text is open, so it does not send the old text under the editor.
 * Not persisted: a reload drops an unsaved draft, as it drops the composer's own text.
 */
export interface QueueEdit {
    draft: string;
    id: string;
}

/**
 * A send the queue refused while the head's text was open; `explicit` is the Send next button's (or an offline replay's)
 * intent. `id` is the message the hold protects: only a send of that message fulfils it.
 */
export interface HeldSend {
    explicit: boolean;
    id?: string;
}

interface QueueEditStore {
    /** Drops every open edit, held send, failed-save mark and error-pause mark: the session that had them has ended. */
    clear: () => void;
    editing: Record<string, QueueEdit | undefined>;
    /** The thread's queue is paused by a reply's error (set through `setPaused`'s `byError`). */
    errorPaused: Record<string, boolean | undefined>;
    /** A permission-mode save failed for the thread and paused its queue: an explicit held send must not resume that pause. */
    failedSave: Record<string, boolean | undefined>;
    held: Record<string, HeldSend | undefined>;
    /** Records that a send was refused for the open head edit of `id`. Repeated holds for one message keep any explicit intent. */
    holdSend: (threadId: string, explicit: boolean, id?: string) => void;
    /** Marks (or clears) that the thread's queue is paused by a reply's error, the only pause an explicit held send may lift. */
    markErrorPause: (threadId: string, on: boolean) => void;
    /** Marks (or clears) a failed permission-mode save for the thread. */
    markFailedSave: (threadId: string, failed: boolean) => void;
    /** Returns the thread's held send and clears it. */
    /** Moves a hold from a message's old id to its new one, when a saved change gave the message a new id. */
    renameHeldSend: (threadId: string, fromId: string, toId: string) => void;
    /** Keeps the draft of the open edit of `id`. */
    setDraft: (threadId: string, id: string, draft: string) => void;
    /** Opens the edit of `id` with `draft` (the message's current text). Refused while another message's editor is open. */
    start: (threadId: string, id: string, draft: string) => void;
    /** Stops the edit of `id`, if that is the one open; a stale call for another chip changes nothing. */
    stop: (threadId: string, id: string) => void;
    takeHeldSend: (threadId: string) => HeldSend | undefined;
}

export const useQueueEditStore = create<QueueEditStore>()((set, get) => {
    return {
        editing: {},
        errorPaused: {},
        failedSave: {},
        held: {},
        clear: () => {
            set({ editing: {}, errorPaused: {}, failedSave: {}, held: {} });
        },
        markErrorPause: (threadId, on) => {
            set((state) => {
                return { errorPaused: { ...state.errorPaused, [threadId]: on } };
            });
        },
        markFailedSave: (threadId, failed) => {
            set((state) => {
                return { failedSave: { ...state.failedSave, [threadId]: failed } };
            });
        },
        holdSend: (threadId, explicit, id) => {
            const current = get().held[threadId];
            const sameMessage = current?.id === id;

            if (current !== undefined && sameMessage && (current.explicit || !explicit)) {
                return;
            }

            set((state) => {
                return { held: { ...state.held, [threadId]: { explicit: explicit || (sameMessage && current?.explicit === true), id } } };
            });
        },
        setDraft: (threadId, id, draft) => {
            set((state) => {
                if (state.editing[threadId]?.id !== id) {
                    return state;
                }

                return { editing: { ...state.editing, [threadId]: { draft, id } } };
            });
        },
        start: (threadId, id, draft) => {
            set((state) => {
                // One open editor per thread: another chip's unsaved draft is not replaced.
                const open = state.editing[threadId];

                if (open !== undefined && open.id !== id) {
                    return state;
                }

                return { editing: { ...state.editing, [threadId]: { draft, id } } };
            });
        },
        stop: (threadId, id) => {
            set((state) => {
                if (state.editing[threadId]?.id !== id) {
                    return state;
                }

                return { editing: { ...state.editing, [threadId]: undefined } };
            });
        },
        renameHeldSend: (threadId, fromId, toId) => {
            set((state) => {
                const held = state.held[threadId];

                if (held?.id !== fromId) {
                    return state;
                }

                return { held: { ...state.held, [threadId]: { ...held, id: toId } } };
            });
        },
        takeHeldSend: (threadId) => {
            const held = get().held[threadId];

            if (held !== undefined) {
                set((state) => {
                    return { held: { ...state.held, [threadId]: undefined } };
                });
            }

            return held;
        },
    };
});

/** The open edit of a thread, if any. Undefined for no thread. */
export const selectThreadEdit =
    (threadId: string | undefined) =>
    (state: QueueEditStore): QueueEdit | undefined =>
        threadId === undefined ? undefined : state.editing[threadId];
