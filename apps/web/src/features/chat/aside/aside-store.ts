import { create } from "zustand";

/**
 * The side questions asked in this browser session, per thread. Nothing here
 * is sent to or stored on the server beyond the one model call that answers
 * it: a question and its answer live in this store (and so in the panel) until
 * the page is closed, or "Add to thread" posts the answer as a message.
 */
export type AsideStatus = "added" | "answered" | "failed" | "pending";

export interface AsideEntry {
    /** Why "Add to thread" was refused, when it was; the answer stays so it can be tried again. */
    addErrorCode?: string;
    answer?: string;
    /** Why `failed`: the server's code, for wording the panel can act on. */
    errorCode?: string;
    id: string;
    question: string;
    status: AsideStatus;
    /** False when the model saw the question alone (a coding agent's thread). */
    withThread?: boolean;
}

interface AsideState {
    add: (threadId: string, entry: AsideEntry) => void;
    byThread: Readonly<Record<string, ReadonlyArray<AsideEntry>>>;
    clear: (threadId: string) => void;
    remove: (threadId: string, id: string) => void;
    update: (threadId: string, id: string, patch: Partial<Omit<AsideEntry, "id" | "question">>) => void;
}

/** A session keeps the newest questions; the oldest fall off so the panel stays short. */
export const MAX_ASIDE_ENTRIES = 20;

export const useAsideStore = create<AsideState>()((set) => {
    return {
        add: (threadId, entry) =>
            set((state) => {
                const entries = [...(state.byThread[threadId] ?? []), entry].slice(-MAX_ASIDE_ENTRIES);

                return { byThread: { ...state.byThread, [threadId]: entries } };
            }),
        byThread: {},
        clear: (threadId) =>
            set((state) => {
                return { byThread: Object.fromEntries(Object.entries(state.byThread).filter(([id]) => id !== threadId)) };
            }),
        remove: (threadId, id) =>
            set((state) => {
                const entries = state.byThread[threadId];

                return entries ? { byThread: { ...state.byThread, [threadId]: entries.filter((entry) => entry.id !== id) } } : state;
            }),
        update: (threadId, id, patch) =>
            set((state) => {
                const entries = state.byThread[threadId];

                if (!entries) {
                    return state;
                }

                return { byThread: { ...state.byThread, [threadId]: entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) } };
            }),
    };
});
