"use client";

import { createContext } from "react";

import type { GalleryItem } from "./image-gallery";

interface ImageGalleryContextValue {
    items: GalleryItem[];
    maxSelections: number;
    onItemClick: (item: GalleryItem) => void;
    onSelect: (ids: string[]) => void;
    onToggleSelection: (item: GalleryItem) => void;
    selectedIds: string[];
    selectionEnabled: boolean;
}

const ImageGalleryContext = createContext<ImageGalleryContextValue | null>(null);

export { ImageGalleryContext, type ImageGalleryContextValue };
