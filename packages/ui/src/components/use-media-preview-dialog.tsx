"use client";

import { use } from "react";

import { MediaPreviewDialogContext } from "./media-preview-dialog-context";

const useMediaPreviewDialog = () => {
    const context = use(MediaPreviewDialogContext);

    if (!context) {
        throw new Error("useMediaPreviewDialog must be used within <MediaPreviewDialog />");
    }

    return context;
};

export { useMediaPreviewDialog };
