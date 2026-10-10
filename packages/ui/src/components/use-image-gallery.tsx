"use client";

import { use } from "react";

import { ImageGalleryContext } from "./image-gallery-context";

const useImageGallery = () => {
    const context = use(ImageGalleryContext);

    if (!context) {
        throw new Error("useImageGallery must be used within <ImageGallery />");
    }

    return context;
};

export { useImageGallery };
