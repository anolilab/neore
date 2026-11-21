import { create } from "zustand";

/**
 * Which thread's image gallery is open, and at which image. Keyed by thread so that, in the split view, an image
 * opened in one pane never opens the gallery of another: each chat's `ChatImageGallery`, mounted inside its `Thread`,
 * renders its own gallery and shows only the selection for its own thread.
 */
interface ImageGalleryState {
    close: () => void;

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
    shown: { key: string | null; threadId: string } | null;
}

/** The focused element when the gallery opens: the control that opened it. */
const focusedControl = (): HTMLElement | null =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;

export const useImageGalleryStore = create<ImageGalleryState>()((set, get) => {
    return {
        close: () => set({ shown: null }),
        opener: null,
        // Stepping through an open gallery keeps the control that opened it.
        openAt: (threadId, key, opener) => set({ opener: opener ?? (get().shown === null ? focusedControl() : get().opener), shown: { key, threadId } }),
        shown: null,
    };
});
