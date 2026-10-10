/**
 * Multi-select state for "Forward messages".
 *
 * A store of its own, not a prop or a chat-context field: chat rows are
 * memoized on message identity (CLAUDE.md, "Chat rows are memoized on message
 * IDENTITY"), so selection must never change a context every row reads. Each
 * row subscribes to ONE boolean — `selectIsSelected(id)` — and re-renders only
 * when that boolean flips; the bar subscribes to the count.
 *
 * Selection belongs to one thread (`threadId`); a row of any other thread
 * reads as "not in select mode", so navigating away needs no cleanup to be
 * correct (the bar still clears it on unmount).
 */
import { create } from "zustand";

/** The most messages one forward carries. */
export const MAX_FORWARD_MESSAGES = 50;

interface ForwardSelectionState {
    /** Ends select mode and drops the selection. */
    clear: () => void;
    /** Select ids, in the order they were picked; kept as a record for O(1) lookup. */
    selected: Readonly<Record<string, true>>;
    /** Enters select mode on `threadId`, optionally with one message already picked. */
    start: (threadId: string, messageId?: string) => void;
    /** The thread select mode is on, or `null` when it is off. */
    threadId: null | string;
    /** Adds or removes one message; refuses to go past {@link MAX_FORWARD_MESSAGES}. */
    toggle: (messageId: string, selected: boolean) => void;
}

export const useForwardSelectionStore = create<ForwardSelectionState>()((set) => {
    return {
        clear: () => set({ selected: {}, threadId: null }),
        selected: {},
        start: (threadId, messageId) => set({ selected: messageId ? { [messageId]: true } : {}, threadId }),
        threadId: null,
        toggle: (messageId, selected) =>
            set((state) => {
                if (selected === Object.hasOwn(state.selected, messageId)) {
                    return state;
                }

                if (!selected) {
                    return { selected: Object.fromEntries(Object.entries(state.selected).filter(([id]) => id !== messageId)) };
                }

                if (Object.keys(state.selected).length >= MAX_FORWARD_MESSAGES) {
                    return state;
                }

                return { selected: { ...state.selected, [messageId]: true } };
            }),
    };
});

export const selectIsSelectMode =
    (threadId: null | string | undefined) =>
    (state: ForwardSelectionState): boolean =>
        threadId !== undefined && threadId !== null && state.threadId === threadId;

export const selectSelectedCount = (state: ForwardSelectionState): number => Object.keys(state.selected).length;
