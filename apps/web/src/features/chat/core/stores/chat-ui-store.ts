"use client";

/**
 * Chat UI Store - Zustand store for UI-only chat state
 *
 * Manages composer text, attachments, editing state, hover state, and scroll position.
 * This is separate from the thread/message data which comes directly from Lunora.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";

/**
 * Batching utility for high-frequency updates
 *
 * Uses requestAnimationFrame to batch updates and reduce re-renders.
 * Falls back to immediate execution in SSR environments.
 */
const createBatcher = <T>() => {
    let pending: T | null = null;
    let isScheduled = false;

    return (callback: (value: T) => void, value: T) => {
        pending = value;

        if (globalThis.window === undefined) {
            callback(value);

            return;
        }

        if (!isScheduled) {
            isScheduled = true;
            requestAnimationFrame(() => {
                isScheduled = false;

                if (pending !== null) {
                    callback(pending);
                    pending = null;
                }
            });
        }
    };
};

// Create batchers for high-frequency actions
// Note: composerText is NOT batched - it needs synchronous updates to preserve cursor position
const hoveredMessageBatcher = createBatcher<string | null>();
const isAtBottomBatcher = createBatcher<boolean>();

/**
 * Pending attachment before upload completes
 */
export interface PendingAttachment {
    error?: string;
    file: File;
    fileId?: string; // Lunora file ID after upload
    id: string;
    name: string;
    progress?: number;
    status: "pending" | "uploading" | "complete" | "error";
    type: "image" | "file" | "document";
}

interface ChatUIStore {
    // Canvas/Artifact state
    activeDocumentId: string | null;
    // Right sidebar tab state
    activeRightSidebarTab: string;

    addAttachment: (file: File) => string; // Returns attachment ID
    addEditAttachment: (file: File) => string;

    /**
     * Reference images attached to the next outgoing message. Ordered — index
     * is the badge number the user sees ("1, 2, 3..."). Cleared on send.
     */
    attachedReferences: ReferenceSelection[];
    canvasDirty: boolean;

    canvasEditMode: "edit" | "preview";
    canvasHistoryVersions: [number, number] | null;

    canvasViewMode: "editor" | "history";

    clearComposer: () => void;

    clearTransitioningMessage: (threadId: string) => void;

    closeCanvas: () => void;

    composerAttachments: PendingAttachment[];

    // Banned content error returned by the server — restores composer text + shows inline error
    composerBannedContent: { message: string; words: string[] } | null;
    // Composer state
    composerText: string;
    copiedMessageId: string | null;
    editAttachments: PendingAttachment[];
    // Edit mode state
    editingMessageId: string | null;
    editText: string;

    // UI interaction state
    hoveredMessageId: string | null;
    // Scroll state
    isAtBottom: boolean;
    isCanvasOpen: boolean;
    // Submission state (to prevent suggestions from opening between submit and streaming)
    isSubmitting: boolean;
    // Canvas/Artifact actions
    openCanvas: (documentId: string) => void;

    removeAttachedReference: (id: string) => void;
    removeAttachment: (id: string) => void;
    removeEditAttachment: (id: string) => void;
    // Reset
    reset: () => void;
    setActiveDocumentId: (documentId: string | null) => void;
    // Right sidebar tab actions
    setActiveRightSidebarTab: (tab: string) => void;
    setAttachedReferences: (references: ReferenceSelection[]) => void;
    setCanvasDirty: (dirty: boolean) => void;

    setCanvasEditMode: (mode: "edit" | "preview") => void;
    setCanvasHistoryVersions: (versions: [number, number] | null) => void;

    setCanvasViewMode: (mode: "editor" | "history") => void;

    // Banned content actions
    setComposerBannedContent: (value: { message: string; words: string[] } | null) => void;

    // Composer actions
    setComposerText: (text: string) => void;

    setCopiedMessageId: (id: string | null) => void;
    setEditText: (text: string) => void;

    // UI interaction actions
    setHoveredMessageId: (id: string | null) => void;

    // Scroll actions
    setIsAtBottom: (isAtBottom: boolean) => void;
    // Submission actions
    setIsSubmitting: (isSubmitting: boolean) => void;
    // Transitioning message actions (for smooth route transitions)
    setTransitioningMessage: (message: { text: string; threadId: string } | null) => void;
    // Edit mode actions
    startEditing: (messageId: string, text: string, attachments?: PendingAttachment[]) => void;
    stopEditing: () => void;
    // Transitioning message state (persists across route changes during new thread creation)
    transitioningMessage: { text: string; threadId: string } | null;
    updateAttachment: (id: string, updates: Partial<PendingAttachment>) => void;

    updateEditAttachment: (id: string, updates: Partial<PendingAttachment>) => void;
}

const generateAttachmentId = () => `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const getAttachmentType = (file: File): "image" | "file" | "document" => {
    if (file.type.startsWith("image/")) {
        return "image";
    }

    if (file.type === "application/pdf" || file.type.includes("document") || file.type.includes("text/")) {
        return "document";
    }

    return "file";
};

const initialState = {
    activeDocumentId: null as string | null,
    activeRightSidebarTab: "summary",
    attachedReferences: [] as ReferenceSelection[],
    canvasDirty: false,
    canvasEditMode: "edit" as "edit" | "preview",
    canvasHistoryVersions: null as [number, number] | null,
    canvasViewMode: "editor" as "editor" | "history",
    composerAttachments: [] as PendingAttachment[],
    composerBannedContent: null as { message: string; words: string[] } | null,
    composerText: "",
    copiedMessageId: null as string | null,
    editAttachments: [] as PendingAttachment[],
    editingMessageId: null as string | null,
    editText: "",
    hoveredMessageId: null as string | null,
    isAtBottom: true,
    isCanvasOpen: false,
    isSubmitting: false,
    transitioningMessage: null as { text: string; threadId: string } | null,
};

export const useChatUIStore = create<ChatUIStore>()(
    devtools(
        subscribeWithSelector((set, get) => {
            return {
                ...initialState,

                addAttachment: (file) => {
                    const id = generateAttachmentId();
                    const attachment: PendingAttachment = {
                        file,
                        id,
                        name: file.name,
                        status: "pending",
                        type: getAttachmentType(file),
                    };

                    set((state) => {
                        return {
                            composerAttachments: [...state.composerAttachments, attachment],
                        };
                    });

                    return id;
                },

                addEditAttachment: (file) => {
                    const id = generateAttachmentId();
                    const attachment: PendingAttachment = {
                        file,
                        id,
                        name: file.name,
                        status: "pending",
                        type: getAttachmentType(file),
                    };

                    set((state) => {
                        return {
                            editAttachments: [...state.editAttachments, attachment],
                        };
                    });

                    return id;
                },

                clearComposer: () => {
                    set({
                        attachedReferences: [],
                        composerAttachments: [],
                        composerBannedContent: null,
                        composerText: "",
                    });
                },

                clearTransitioningMessage: (threadId) => {
                    // Only clear if the message is for this thread
                    const current = get().transitioningMessage;

                    if (current?.threadId === threadId) {
                        set({ transitioningMessage: null });
                    }
                },

                closeCanvas: () => {
                    set({ canvasDirty: false, isCanvasOpen: false });
                },

                // Canvas/Artifact actions
                openCanvas: (documentId) => {
                    set({
                        activeDocumentId: documentId,
                        canvasDirty: false,
                        canvasEditMode: "edit",
                        canvasHistoryVersions: null,
                        canvasViewMode: "editor",
                        isCanvasOpen: true,
                    });
                },

                removeAttachedReference: (id) => {
                    set((state) => {
                        return {
                            attachedReferences: state.attachedReferences.filter((r) => r.id !== id),
                        };
                    });
                },

                removeAttachment: (id) => {
                    set((state) => {
                        return {
                            composerAttachments: state.composerAttachments.filter((a) => a.id !== id),
                        };
                    });
                },

                removeEditAttachment: (id) => {
                    set((state) => {
                        return {
                            editAttachments: state.editAttachments.filter((a) => a.id !== id),
                        };
                    });
                },

                // Reset
                reset: () => {
                    set(initialState);
                },

                setActiveDocumentId: (documentId) => {
                    set({ activeDocumentId: documentId, canvasDirty: false });
                },

                // Right sidebar tab actions
                setActiveRightSidebarTab: (tab) => {
                    set({ activeRightSidebarTab: tab });
                },

                setAttachedReferences: (references) => {
                    set({ attachedReferences: references });
                },

                setCanvasDirty: (dirty) => {
                    set({ canvasDirty: dirty });
                },

                setCanvasEditMode: (mode) => {
                    set({ canvasEditMode: mode });
                },

                setCanvasHistoryVersions: (versions) => {
                    set({ canvasHistoryVersions: versions });
                },

                setCanvasViewMode: (mode) => {
                    set({ canvasViewMode: mode });
                },

                // Banned content actions
                setComposerBannedContent: (value) => {
                    set({ composerBannedContent: value });
                },

                // Composer actions - synchronous to preserve cursor position
                setComposerText: (text) => {
                    set({ composerText: text });
                },

                setCopiedMessageId: (id) => {
                    set({ copiedMessageId: id });

                    // Auto-clear copied state after 2 seconds
                    if (id) {
                        setTimeout(() => {
                            const currentCopied = get().copiedMessageId;

                            if (currentCopied === id) {
                                set({ copiedMessageId: null });
                            }
                        }, 2000);
                    }
                },

                setEditText: (text) => {
                    set({ editText: text });
                },

                // UI interaction actions - using batching for high-frequency updates
                setHoveredMessageId: (id) => {
                    hoveredMessageBatcher((hid) => set({ hoveredMessageId: hid }), id);
                },

                // Scroll actions - using batching for high-frequency scroll updates
                setIsAtBottom: (isAtBottom) => {
                    isAtBottomBatcher((b) => set({ isAtBottom: b }), isAtBottom);
                },

                // Submission actions
                setIsSubmitting: (isSubmitting) => {
                    set({ isSubmitting });
                },

                // Transitioning message actions (for smooth route transitions)
                setTransitioningMessage: (message) => {
                    set({ transitioningMessage: message });
                },

                // Edit mode actions
                startEditing: (messageId, text, attachments = []) => {
                    set({
                        editAttachments: attachments,
                        editingMessageId: messageId,
                        editText: text,
                    });
                },

                stopEditing: () => {
                    set({
                        editAttachments: [],
                        editingMessageId: null,
                        editText: "",
                    });
                },

                updateAttachment: (id, updates) => {
                    set((state) => {
                        return {
                            composerAttachments: state.composerAttachments.map((a) => (a.id === id ? { ...a, ...updates } : a)),
                        };
                    });
                },

                updateEditAttachment: (id, updates) => {
                    set((state) => {
                        return {
                            editAttachments: state.editAttachments.map((a) => (a.id === id ? { ...a, ...updates } : a)),
                        };
                    });
                },
            };
        }),
        { enabled: process.env.NODE_ENV === "development", name: "chat-ui-store" },
    ),
);

// Stable selector functions - define outside components for stable references
export const selectComposerText = (state: ChatUIStore) => state.composerText;
export const selectComposerAttachments = (state: ChatUIStore) => state.composerAttachments;
export const selectAttachedReferences = (state: ChatUIStore) => state.attachedReferences;
export const selectSetAttachedReferences = (state: ChatUIStore) => state.setAttachedReferences;
export const selectRemoveAttachedReference = (state: ChatUIStore) => state.removeAttachedReference;
export const selectIsAtBottom = (state: ChatUIStore) => state.isAtBottom;
export const selectEditingMessageId = (state: ChatUIStore) => state.editingMessageId;
export const selectEditText = (state: ChatUIStore) => state.editText;
export const selectEditAttachments = (state: ChatUIStore) => state.editAttachments;
export const selectHoveredMessageId = (state: ChatUIStore) => state.hoveredMessageId;
export const selectCopiedMessageId = (state: ChatUIStore) => state.copiedMessageId;

export const selectActiveRightSidebarTab = (state: ChatUIStore) => state.activeRightSidebarTab;
export const selectSetActiveRightSidebarTab = (state: ChatUIStore) => state.setActiveRightSidebarTab;

export const selectActiveDocumentId = (state: ChatUIStore) => state.activeDocumentId;
export const selectIsCanvasOpen = (state: ChatUIStore) => state.isCanvasOpen;
export const selectCanvasEditMode = (state: ChatUIStore) => state.canvasEditMode;
export const selectCanvasDirty = (state: ChatUIStore) => state.canvasDirty;
export const selectCanvasViewMode = (state: ChatUIStore) => state.canvasViewMode;
export const selectCanvasHistoryVersions = (state: ChatUIStore) => state.canvasHistoryVersions;

// Action selectors
export const selectSetComposerText = (state: ChatUIStore) => state.setComposerText;
export const selectSetIsAtBottom = (state: ChatUIStore) => state.setIsAtBottom;
export const selectSetHoveredMessageId = (state: ChatUIStore) => state.setHoveredMessageId;
export const selectSetCopiedMessageId = (state: ChatUIStore) => state.setCopiedMessageId;
export const selectClearComposer = (state: ChatUIStore) => state.clearComposer;
export const selectStartEditing = (state: ChatUIStore) => state.startEditing;
export const selectStopEditing = (state: ChatUIStore) => state.stopEditing;

// Convenience hooks for specific slices - use separate selectors to avoid infinite loops
export const useComposerState = () => {
    const text = useChatUIStore((state) => state.composerText);
    const attachments = useChatUIStore((state) => state.composerAttachments);
    const setText = useChatUIStore((state) => state.setComposerText);
    const addAttachment = useChatUIStore((state) => state.addAttachment);
    const updateAttachment = useChatUIStore((state) => state.updateAttachment);
    const removeAttachment = useChatUIStore((state) => state.removeAttachment);
    const clear = useChatUIStore((state) => state.clearComposer);

    return { addAttachment, attachments, clear, removeAttachment, setText, text, updateAttachment };
};

export const useEditState = () => {
    const editingMessageId = useChatUIStore((state) => state.editingMessageId);
    const text = useChatUIStore((state) => state.editText);
    const attachments = useChatUIStore((state) => state.editAttachments);
    const setText = useChatUIStore((state) => state.setEditText);
    const addAttachment = useChatUIStore((state) => state.addEditAttachment);
    const updateAttachment = useChatUIStore((state) => state.updateEditAttachment);
    const removeAttachment = useChatUIStore((state) => state.removeEditAttachment);
    const startEditing = useChatUIStore((state) => state.startEditing);
    const stopEditing = useChatUIStore((state) => state.stopEditing);
    const isEditing = editingMessageId !== null;

    return { addAttachment, attachments, editingMessageId, isEditing, removeAttachment, setText, startEditing, stopEditing, text, updateAttachment };
};

export const useScrollState = () => {
    const isAtBottom = useChatUIStore((state) => state.isAtBottom);
    const setIsAtBottom = useChatUIStore((state) => state.setIsAtBottom);

    return { isAtBottom, setIsAtBottom };
};

export const useCanvasState = () => {
    const activeDocumentId = useChatUIStore((state) => state.activeDocumentId);
    const isCanvasOpen = useChatUIStore((state) => state.isCanvasOpen);
    const canvasEditMode = useChatUIStore((state) => state.canvasEditMode);
    const canvasDirty = useChatUIStore((state) => state.canvasDirty);
    const canvasViewMode = useChatUIStore((state) => state.canvasViewMode);
    const canvasHistoryVersions = useChatUIStore((state) => state.canvasHistoryVersions);
    const openCanvas = useChatUIStore((state) => state.openCanvas);
    const closeCanvas = useChatUIStore((state) => state.closeCanvas);
    const setActiveDocumentId = useChatUIStore((state) => state.setActiveDocumentId);
    const setCanvasEditMode = useChatUIStore((state) => state.setCanvasEditMode);
    const setCanvasDirty = useChatUIStore((state) => state.setCanvasDirty);
    const setCanvasViewMode = useChatUIStore((state) => state.setCanvasViewMode);
    const setCanvasHistoryVersions = useChatUIStore((state) => state.setCanvasHistoryVersions);

    return {
        activeDocumentId,
        canvasDirty,
        canvasEditMode,
        canvasHistoryVersions,
        canvasViewMode,
        closeCanvas,
        isCanvasOpen,
        openCanvas,
        setActiveDocumentId,
        setCanvasDirty,
        setCanvasEditMode,
        setCanvasHistoryVersions,
        setCanvasViewMode,
    };
};

export const useMessageInteractionState = (messageId: string) => {
    // Use separate selectors to avoid creating new object references
    const isHovered = useChatUIStore((state) => state.hoveredMessageId === messageId);
    const isCopied = useChatUIStore((state) => state.copiedMessageId === messageId);
    const setHoveredMessageId = useChatUIStore((state) => state.setHoveredMessageId);
    const setCopiedMessageId = useChatUIStore((state) => state.setCopiedMessageId);

    const setHovered = (hovered: boolean) => setHoveredMessageId(hovered ? messageId : null);
    const setCopied = () => setCopiedMessageId(messageId);

    return { isCopied, isHovered, setCopied, setHovered };
};
