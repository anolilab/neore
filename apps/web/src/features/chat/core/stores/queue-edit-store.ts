import { create } from "zustand";

/**
 * The queued message whose text is open for editing in its chip, and the draft typed so far, per thread.
 *
 * Kept here, not in the chip, for two reasons: a chip that remounts (the reply ending, a re-key) keeps its unsaved
 * draft, and the queue's drain knows the head's text is open, so it does not send the old text under the editor.
 * Not persisted: a reload drops an unsaved draft, as it drops the composer's own text.
 */
export interface QueueEdit {
    draft: string;
    id: string;
}

interface QueueEditStore {
    editing: Record<string, QueueEdit | undefined>;
    /** Keeps the draft of the open edit of `id`. */
    setDraft: (threadId: string, id: string, draft: string) => void;
    /** Opens the edit of `id` with `draft` (the message's current text). */
    start: (threadId: string, id: string, draft: string) => void;
    /** Stops the edit of `id`, if that is the one open; a stale call for another chip changes nothing. */
    stop: (threadId: string, id: string) => void;
}

export const useQueueEditStore = create<QueueEditStore>()((set) => {
    return {
        editing: {},
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
    };
});

/** The open edit of a thread, if any. Undefined for no thread. */
export const selectThreadEdit =
    (threadId: string | undefined) =>
    (state: QueueEditStore): QueueEdit | undefined =>
        threadId === undefined ? undefined : state.editing[threadId];
