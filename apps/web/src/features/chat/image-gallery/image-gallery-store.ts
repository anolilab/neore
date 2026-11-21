import { create } from "zustand";

/**
 * Which thread's image gallery is open, and at which image. Keyed by thread so that, in the split view, an image
 * opened in one pane never opens the gallery of another: each chat's `ChatImageGallery`, mounted inside its `Thread`,
 * renders its own gallery and shows only the selection for its own thread.
 */
interface ImageGalleryState {
    close: () => void;
    /** Closes only while the selection is still this one: a pane forgetting its gone image never closes another's newer. */
    closeIf: (threadId: string, key: string | null) => void;
    /** Per thread, whether its message list is showing (not the image or video mode's grid): Go to message needs it. */
    listShown: Record<string, boolean>;

    /**
     * Opens the gallery of `threadId` at `key`, or at its first image when `key` is `null`. `opener` is the clicked control:
     * Safari does not focus a button on click, so the focused element alone does not say what opened the gallery.
     */
    openAt: (threadId: string, key: string | null, opener?: HTMLElement) => void;

    /**
     * The control that opened the gallery (the header button, an image in a reply). Kept after a close, so the dialog can
     * hand focus back to it once it has closed.
     */
    opener: HTMLElement | null;

    setListShown: (threadId: string, shown: boolean) => void;
    shown: { key: string | null; threadId: string } | null;
}

/** The focused element when the gallery opens: the control that opened it. */
const focusedControl = (): HTMLElement | null =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;

export const useImageGalleryStore = create<ImageGalleryState>()((set, get) => {
    return {
        close: () => set({ shown: null }),
        listShown: {},
        setListShown: (threadId, shown) => {
            if (get().listShown[threadId] !== shown) {
                set({ listShown: { ...get().listShown, [threadId]: shown } });
            }
        },
        closeIf: (threadId, key) => {
            const { shown } = get();

            if (shown?.threadId === threadId && shown.key === key) {
                set({ shown: null });
            }
        },
        opener: null,
        // Stepping through an open gallery keeps the control that opened it.
        openAt: (threadId, key, opener) => set({ opener: opener ?? (get().shown === null ? focusedControl() : get().opener), shown: { key, threadId } }),
        shown: null,
    };
});
