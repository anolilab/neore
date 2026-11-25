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

/** A send the queue refused while the head's text was open; `explicit` is the Send next button's (or an offline replay's) intent. */
export interface HeldSend {
    explicit: boolean;
}

interface QueueEditStore {
    /** Drops every open edit and held send: the session that had them has ended. */
    clear: () => void;
    editing: Record<string, QueueEdit | undefined>;
    held: Record<string, HeldSend | undefined>;
    /** Records that a send was refused for the open head edit. Repeated holds keep the explicit intent of any of them. */
    holdSend: (threadId: string, explicit: boolean) => void;
    /** Keeps the draft of the open edit of `id`. */
    setDraft: (threadId: string, id: string, draft: string) => void;
    /** Opens the edit of `id` with `draft` (the message's current text). Refused while another message's editor is open. */
    start: (threadId: string, id: string, draft: string) => void;
    /** Stops the edit of `id`, if that is the one open; a stale call for another chip changes nothing. */
    stop: (threadId: string, id: string) => void;
    /** Returns the thread's held send and clears it. */
    takeHeldSend: (threadId: string) => HeldSend | undefined;
}

export const useQueueEditStore = create<QueueEditStore>()((set, get) => {
    return {
        editing: {},
        held: {},
        clear: () => {
            set({ editing: {}, held: {} });
        },
        holdSend: (threadId, explicit) => {
            const current = get().held[threadId];

            if (current !== undefined && (current.explicit || !explicit)) {
                return;
            }

            set((state) => {
                return { held: { ...state.held, [threadId]: { explicit: explicit || current?.explicit === true } } };
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
