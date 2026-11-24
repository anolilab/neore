import { useEffect } from "react";
import { create } from "zustand";

/**
 * The pane of a chat that a keyboard activation asked to take focus, once it is shown. Not persisted: it is transient, and a write
 * to the saved layout that failed could otherwise stop the link's navigation.
 */
export const useComposerFocusRequestStore = create<{
    clear: (threadId: string) => void;
    request: (threadId: string) => void;
    threadId?: string;
}>()((set, get) => {
    return {
        clear: (threadId) => {
            if (get().threadId === threadId) {
                set({ threadId: undefined });
            }
        },
        request: (threadId) => {
            set({ threadId });
        },
    };
});

/** Asks the pane of `threadId` to move keyboard focus into its composer. */
export const requestComposerFocus = (threadId: string): void => {
    useComposerFocusRequestStore.getState().request(threadId);
};

/** Clears the request, if it is still for `threadId`: a pane that is done or gone must not clear another pane's request. */
export const clearComposerFocusRequest = (threadId: string): void => {
    useComposerFocusRequestStore.getState().clear(threadId);
};

/** How many frames to wait for the composer's editor (it loads lazily) before giving up on moving focus into it. */
export const FOCUS_FRAMES = 60;

/** The composer's input: the chat editor, or a worker's textarea (which has no textbox role). */
export const COMPOSER_INPUT = '[role="textbox"], textarea[data-focus-area="composer"]';

/**
 * Moves focus into a pane's composer once it has mounted (it loads lazily). `onSettled` runs once: with `true` when the composer has taken
 * focus, with `false` when it did not mount within `FOCUS_FRAMES` frames. Returns a function that stops the retries.
 */
export const focusComposerWhenMounted = (pane: { current: HTMLElement | null }, onSettled: (focused: boolean) => void): (() => void) => {
    let frame = 0;
    let frames = 0;
    // Focus is taken only from where it was when the request began, or from the page: once the person has moved it elsewhere, the composer
    // leaves it there.
    const startedFrom = document.activeElement;
    const focusEditor = () => {
        const current = document.activeElement;

        if (current !== startedFrom && current !== document.body && current !== null) {
            onSettled(false);

            return;
        }

        const editor = pane.current?.querySelector<HTMLElement>(COMPOSER_INPUT);

        if (editor) {
            editor.focus();
            onSettled(true);

            return;
        }

        frames += 1;

        if (frames < FOCUS_FRAMES) {
            frame = requestAnimationFrame(focusEditor);

            return;
        }

        onSettled(false);
    };

    focusEditor();

    return () => cancelAnimationFrame(frame);
};

/**
 * Moves focus into a pane's composer when a keyboard activation asked for it: once the pane is focused and its composer has mounted. The
 * request is cleared when the composer takes focus or gives up, and when the pane is left meanwhile.
 */
export const useComposerFocusRequest = (pane: { current: HTMLElement | null }, threadId: string, isFocused: boolean): void => {
    const isRequested = useComposerFocusRequestStore((state) => state.threadId === threadId);

    useEffect(() => {
        if (!(isFocused && isRequested)) {
            return undefined;
        }

        const cancel = focusComposerWhenMounted(pane, () => clearComposerFocusRequest(threadId));

        return () => {
            cancel();
            clearComposerFocusRequest(threadId);
        };
    }, [isFocused, isRequested, pane, threadId]);
};
