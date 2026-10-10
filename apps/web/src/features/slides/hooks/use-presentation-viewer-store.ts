/**
 * Zustand store for the presentation full-screen viewer.
 * Ported from kortix-ai/suna presentation-viewer-store.tsx
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

import type { PresentationViewerState } from "../types";

const usePresentationViewerStore = create<PresentationViewerState>()(
    devtools(
        (set) => {
            return {
                closePresentation: () => {
                    set({
                        initialSlide: undefined,
                        isOpen: false,
                        presentationId: undefined,
                    });
                },
                initialSlide: undefined,
                isOpen: false,

                openPresentation: (presentationId: string, initialSlide = 1) => {
                    set({
                        initialSlide,
                        isOpen: true,
                        presentationId,
                    });
                },

                presentationId: undefined,
            };
        },
        { name: "presentation-viewer-store" },
    ),
);

export default usePresentationViewerStore;
