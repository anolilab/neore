import type { PhotonEditorMessages } from "@ui/components/image-editor/photon-image-editor";

const DEFAULT_PHOTON_EDITOR_MESSAGES: PhotonEditorMessages = {
    apply: "Apply",
    cancel: "Cancel",
    categoryAdjust: "Adjust",
    categoryChannel: "Channels",
    categoryColor: "Color",
    categoryEffect: "Effects",
    categoryFilter: "Filters",
    categoryTransform: "Transform",
    corsBlocked: "This image's host does not allow editing. Re-upload or generate a new image to enable editing.",
    downloadPng: "Download PNG",
    imageTooLarge: "The edited image is too large to save (>1 MB). Try cropping, downscaling, or applying fewer effects.",
    initFailed: "Failed to initialize image editor",
    loadError: "Could not load image",
    loadingEditor: "Loading editor…",
    loadingImageEditor: "Loading image editor…",
    operationFailed: (label) => `Operation "${label}" failed`,
    previewLabel: (label) => `Preview: ${label}`,
    ready: "Ready",
    redo: "Redo",
    reset: "Reset",
    saveAriaLabel: "Save as new version",
    saveFailed: "Save failed",
    saveVersion: "Save version",
    saving: "Saving…",
    undo: "Undo",
    unsavedEdits: (n) => `${n} unsaved edit${n === 1 ? "" : "s"}`,
};

export { DEFAULT_PHOTON_EDITOR_MESSAGES };
