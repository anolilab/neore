import { create } from "zustand";

/**
 * Which thread's image gallery is open, and at which image. Keyed by thread so that, in the split view, an image
 * opened in one pane never opens the gallery of another: each chat's `ChatImageGallery`, mounted inside its `Thread`,
 * renders its own gallery and shows only the selection for its own thread.
 */
interface ImageGalleryState {
    close: () => void;
    /** Opens the gallery of `threadId` at `key`, or at its first image when `key` is `null`. */
    openAt: (threadId: string, key: string | null) => void;
    shown: { key: string | null; threadId: string } | null;
}

export const useImageGalleryStore = create<ImageGalleryState>()((set) => {
    return {
        close: () => set({ shown: null }),
        openAt: (threadId, key) => set({ shown: { key, threadId } }),
        shown: null,
    };
});
