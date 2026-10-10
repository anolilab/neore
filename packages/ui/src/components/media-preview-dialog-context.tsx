"use client";

import { createContext } from "react";

import type { MediaItem } from "./media-preview-dialog";

interface MediaPreviewDialogContextValue {
    isPlaying: boolean;
    media: MediaItem | null;
    setIsPlaying: (playing: boolean) => void;
}

const MediaPreviewDialogContext = createContext<MediaPreviewDialogContextValue | null>(null);

export { MediaPreviewDialogContext, type MediaPreviewDialogContextValue };
