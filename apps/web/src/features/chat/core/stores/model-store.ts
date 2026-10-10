"use client";

import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { ImageSize, ModelFilterCapability } from "@neore/ai/models";
import type { CinemaSettings } from "@neore/ai/types/cinema";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

/**
 * A model identifier as stored on threads and sent to the backend, e.g. `"moonshotai/kimi-k2-0905"`.
 * (`AgentModel` from `@neore/ai` is the resolved `{ id, config }` pair, not the id itself.)
 */
export type ModelId = string;

export type ComposerMode = "text" | "image" | "video" | "audio";
export type ResearchDepth = "speed" | "balanced" | "thorough";

export const MAX_COMPARISON_MODELS = 6;
export const MIN_COMPARISON_MODELS = 2;

/**
 * Search mode - determines which tools are active
 */
export type SearchMode =
    | "chat" // No tools - direct conversation
    | "web" // Web search tools
    | "academic" // Academic paper search
    | "x" // X/Twitter search
    | "reddit" // Reddit search
    | "youtube" // YouTube search
    | "stocks" // Stock and currency tools
    | "crypto" // Cryptocurrency tools
    | "code" // Code-related tools (future)
    | "github" // GitHub search (future)
    | "spotify"; // Spotify search (future)

export interface ImageGenerationSettings {
    aspectRatio: ImageSize;
    cinema?: CinemaSettings;
    negativePrompt?: string;
    numImages?: number;
    quality?: "standard" | "hd";
    seed?: number;
    style?: string;
}

export interface VideoGenerationSettings {
    aspectRatio: string; // Model-specific aspect ratio (see FAL_VIDEO_MODELS config)
    cinema?: CinemaSettings;
    duration: number; // in seconds
}

export interface AudioGenerationSettings {
    speed?: number;
    voice?: string;
}

export interface PendingSettings {
    customSystemPrompt?: string;
    enabledFeatures?: string[];
    isTempChat?: boolean;
    language?: string;
    model?: string;
    reasoningEffort?: number;
    retentionHours?: number;
    statelessMode?: boolean;
}

// ============================================================================
// State Interface (data only)
// ============================================================================
interface ModelStoreState {
    activeFilters: Set<ModelFilterCapability>;
    actualDefaultModel: ModelId;
    audioSettings: AudioGenerationSettings;
    // Cinema controls panel state
    cinemaPanelOpen: boolean;
    // Multi-model comparison mode
    comparisonMode: boolean;
    // Current thread ID for mode tracking
    currentModeThreadId: string | undefined;
    fixedThreads: Set<string>;
    imageSettings: ImageGenerationSettings;
    // Selected MCP server names for the current message (empty = all enabled)
    mcpServerNames: string[];
    // Mode for new threads (before they have an ID)
    newThreadMode: ComposerMode;
    open: boolean;
    pendingSettings: PendingSettings | undefined;
    // Selected reference image IDs for image generation
    referenceImageIds: string[];
    researchDepth: ResearchDepth;
    searchMode: SearchMode;
    searchQuery: string;
    selectedModel: ModelId;
    selectedModelsForComparison: ModelId[];
    selectedModelThreadId: string | undefined;
    showFavoritesOnly: boolean;
    showFilters: boolean;
    // Per-thread composer mode (threadId -> mode)
    threadModes: Map<string, ComposerMode>;
    // Flag to prevent sync from overriding user mode changes
    userChangedMode: boolean;
    userChangedModel: boolean;
    videoSettings: VideoGenerationSettings;
}

// ============================================================================
// Actions Interface (functions only)
// ============================================================================
interface ThreadData {
    mode?: "text" | "image" | "video" | "audio";
    model?: string;
}

interface ModelStoreActions {
    clearComparisonSelection: () => void;
    clearFilters: () => void;
    clearReferenceImages: () => void;
    getComposerMode: (threadId: string | undefined) => ComposerMode;
    getPendingSettings: () => PendingSettings | null;
    isModelSelectedForComparison: (model: ModelId) => boolean;
    isThreadFixed: (threadId: string) => boolean;
    loadThreadData: (threadData: ThreadData, threadId: string) => void;
    markModelAsUserChanged: () => void;
    markThreadAsFixed: (threadId: string) => void;
    resetForNewThread: (threadId: string | undefined, defaultModel?: ModelId) => void;
    resetGenerationSettings: () => void;
    setActiveFilters: (filters: Set<ModelFilterCapability> | ((previous: Set<ModelFilterCapability>) => Set<ModelFilterCapability>)) => void;
    setActualDefaultModel: (model: ModelId) => void;
    setAudioSettings: (settings: Partial<AudioGenerationSettings>) => void;
    setCinemaPanelOpen: (open: boolean) => void;
    // Comparison mode actions
    setComparisonMode: (enabled: boolean) => void;
    setComposerMode: (mode: ComposerMode, threadId: string | undefined, userChanged?: boolean) => void;
    setImageSettings: (settings: Partial<ImageGenerationSettings>) => void;
    setMCPServerNames: (names: string[]) => void;
    setOpen: (open: boolean) => void;
    setPendingSettings: (settings: PendingSettings | undefined | ((previous: PendingSettings | undefined) => PendingSettings | undefined)) => void;
    setReferenceImageIds: (ids: string[]) => void;
    setResearchDepth: (depth: ResearchDepth) => void;
    setSearchMode: (mode: SearchMode) => void;
    setSearchQuery: (query: string) => void;
    setSelectedModel: (model: ModelId, threadId: string | undefined) => void;
    setSelectedModelsForComparison: (models: ModelId[]) => void;
    setShowFavoritesOnly: (show: boolean) => void;
    setShowFilters: (show: boolean) => void;
    setVideoSettings: (settings: Partial<VideoGenerationSettings>) => void;
    syncModeFromThread: (mode: ComposerMode, threadId: string | undefined) => void;
    syncModelFromThread: (model: ModelId, threadId: string | undefined) => void;
    toggleCinemaPanel: () => void;
    toggleFilter: (capability: ModelFilterCapability) => void;
    toggleModelForComparison: (model: ModelId) => void;
}

// Combined store type
type ModelStore = ModelStoreActions & ModelStoreState;

// ============================================================================
// Initial State (extracted for reset functionality)
// ============================================================================
const DEFAULT_IMAGE_SETTINGS: ImageGenerationSettings = {
    aspectRatio: "1:1" as ImageSize,
    cinema: {
        aperture: undefined,
        camera: undefined,
        enabled: true,
        focalLength: undefined,
        lens: undefined,
    },
    numImages: 1,
    quality: "standard" as const,
    style: undefined,
};

const DEFAULT_VIDEO_SETTINGS: VideoGenerationSettings = {
    aspectRatio: "16:9" as const,
    cinema: {
        aperture: undefined,
        camera: undefined,
        enabled: true,
        focalLength: undefined,
        lens: undefined,
    },
    duration: 5,
};

const DEFAULT_AUDIO_SETTINGS: AudioGenerationSettings = {
    speed: 1,
    voice: "alloy",
};

const createInitialState = (): ModelStoreState => {
    return {
        activeFilters: new Set(),
        actualDefaultModel: DEFAULT_CHAT_MODEL,
        audioSettings: { ...DEFAULT_AUDIO_SETTINGS },
        cinemaPanelOpen: false,
        comparisonMode: false,
        currentModeThreadId: undefined,
        fixedThreads: new Set(),
        imageSettings: { ...DEFAULT_IMAGE_SETTINGS },
        mcpServerNames: [],
        newThreadMode: "text" as ComposerMode,
        open: false,
        pendingSettings: undefined,
        referenceImageIds: [],
        researchDepth: "balanced" as ResearchDepth,
        searchMode: "chat" as SearchMode,
        searchQuery: "",
        selectedModel: DEFAULT_CHAT_MODEL,
        selectedModelsForComparison: [],
        selectedModelThreadId: undefined,
        showFavoritesOnly: false,
        showFilters: false,
        threadModes: new Map<string, ComposerMode>(),
        userChangedMode: false,
        userChangedModel: false,
        videoSettings: { ...DEFAULT_VIDEO_SETTINGS },
    };
};

// ============================================================================
// Store Creation
// ============================================================================
export const useModelStore = create<ModelStore>()(
    devtools(
        subscribeWithSelector((set, get) => {
            return {
                // Initial state
                ...createInitialState(),

                clearComparisonSelection: () => {
                    set({ selectedModelsForComparison: [] }, undefined, "clearComparisonSelection");
                },

                clearFilters: () => {
                    set(
                        {
                            activeFilters: new Set(),
                            searchQuery: "",
                            showFavoritesOnly: false,
                        },
                        undefined,
                        "clearFilters",
                    );
                },

                clearReferenceImages: () => {
                    set({ referenceImageIds: [] }, undefined, "clearReferenceImages");
                },

                getComposerMode: (threadId) => {
                    const state = get();

                    if (!threadId) {
                        // Return newThreadMode for new threads (before they have an ID)
                        return state.newThreadMode;
                    }

                    return state.threadModes.get(threadId) || "text";
                },

                getPendingSettings: () => {
                    const settings = get().pendingSettings;

                    set({ pendingSettings: undefined }, undefined, "getPendingSettings");

                    return settings ?? null;
                },

                isModelSelectedForComparison: (model) => get().selectedModelsForComparison.includes(model),

                isThreadFixed: (threadId) => get().fixedThreads.has(threadId),

                // ----------------------------------------------------------------
                // Thread Data Loading - single source of truth for thread switch
                // ----------------------------------------------------------------
                loadThreadData: (threadData, threadId) => {
                    set(
                        (state) => {
                            const model = threadData.model || state.actualDefaultModel;
                            const mode = (threadData.mode || "text") as ComposerMode;
                            const newThreadModes = new Map(state.threadModes);

                            newThreadModes.set(threadId, mode);

                            return {
                                // Reset comparison state on every thread switch.
                                // thread.tsx will re-enable it via useEffect if the new thread
                                // turns out to be a comparison parent (has comparison children).
                                comparisonMode: false,
                                currentModeThreadId: threadId,
                                selectedModel: model,
                                selectedModelsForComparison: [],
                                selectedModelThreadId: threadId,
                                threadModes: newThreadModes,
                                userChangedMode: false,
                                userChangedModel: false,
                            };
                        },
                        undefined,
                        "loadThreadData",
                    );
                },

                markModelAsUserChanged: () => {
                    set({ userChangedModel: true }, undefined, "markModelAsUserChanged");
                },

                markThreadAsFixed: (threadId) => {
                    set(
                        (state) => {
                            if (state.fixedThreads.has(threadId)) {
                                return state;
                            }

                            const fixedThreads = new Set(state.fixedThreads);

                            fixedThreads.add(threadId);

                            return { fixedThreads };
                        },
                        undefined,
                        "markThreadAsFixed",
                    );
                },

                // ----------------------------------------------------------------
                // Model Actions
                // ----------------------------------------------------------------
                resetForNewThread: (threadId, defaultModel) => {
                    const modelToUse = defaultModel || get().actualDefaultModel;

                    set(
                        {
                            newThreadMode: "text" as ComposerMode,
                            selectedModel: modelToUse,
                            selectedModelThreadId: threadId,
                            userChangedMode: false,
                            userChangedModel: false,
                        },
                        undefined,
                        "resetForNewThread",
                    );
                },

                resetGenerationSettings: () => {
                    set(
                        {
                            audioSettings: { ...DEFAULT_AUDIO_SETTINGS },
                            imageSettings: { ...DEFAULT_IMAGE_SETTINGS },
                            referenceImageIds: [],
                            videoSettings: { ...DEFAULT_VIDEO_SETTINGS },
                        },
                        undefined,
                        "resetGenerationSettings",
                    );
                },

                setActiveFilters: (filters) => {
                    const next = typeof filters === "function" ? filters(get().activeFilters) : filters;

                    set({ activeFilters: next }, undefined, "setActiveFilters");
                },

                setActualDefaultModel: (model) => {
                    set({ actualDefaultModel: model }, undefined, "setActualDefaultModel");
                },

                setAudioSettings: (settings) => {
                    set(
                        (state) => {
                            return {
                                audioSettings: { ...state.audioSettings, ...settings },
                            };
                        },
                        undefined,
                        "setAudioSettings",
                    );
                },

                // Cinema panel controls
                setCinemaPanelOpen: (open) => {
                    set({ cinemaPanelOpen: open }, undefined, "setCinemaPanelOpen");
                },

                // ----------------------------------------------------------------
                // Comparison Mode Actions
                // ----------------------------------------------------------------
                setComparisonMode: (enabled) => {
                    set(
                        {
                            comparisonMode: enabled,
                            // Clear selection when disabling
                            selectedModelsForComparison: enabled ? get().selectedModelsForComparison : [],
                        },
                        undefined,
                        "setComparisonMode",
                    );
                },

                // ----------------------------------------------------------------
                // Composer Mode Actions
                // ----------------------------------------------------------------
                setComposerMode: (mode, threadId, userChanged = true) => {
                    set(
                        (state) => {
                            if (!threadId) {
                                // No thread ID - store in newThreadMode for new threads
                                return { currentModeThreadId: undefined, newThreadMode: mode, userChangedMode: userChanged };
                            }

                            const newThreadModes = new Map(state.threadModes);

                            newThreadModes.set(threadId, mode);

                            return {
                                currentModeThreadId: threadId,
                                threadModes: newThreadModes,
                                userChangedMode: userChanged,
                            };
                        },
                        undefined,
                        "setComposerMode",
                    );
                },

                // ----------------------------------------------------------------
                // Generation Settings Actions
                // ----------------------------------------------------------------
                setImageSettings: (settings) => {
                    set(
                        (state) => {
                            return {
                                imageSettings: { ...state.imageSettings, ...settings },
                            };
                        },
                        undefined,
                        "setImageSettings",
                    );
                },

                setMCPServerNames: (names) => {
                    set({ mcpServerNames: names }, undefined, "setMCPServerNames");
                },

                // ----------------------------------------------------------------
                // UI State Actions
                // ----------------------------------------------------------------
                setOpen: (open) => {
                    set({ open }, undefined, "setOpen");
                },

                // ----------------------------------------------------------------
                // Settings Actions
                // ----------------------------------------------------------------
                setPendingSettings: (settings) => {
                    if (typeof settings === "function") {
                        set({ pendingSettings: settings(get().pendingSettings) }, undefined, "setPendingSettings");
                    } else {
                        set({ pendingSettings: settings }, undefined, "setPendingSettings");
                    }
                },

                setReferenceImageIds: (ids) => {
                    set({ referenceImageIds: ids }, undefined, "setReferenceImageIds");
                },

                // ----------------------------------------------------------------
                // Search Mode Actions
                // ----------------------------------------------------------------
                setResearchDepth: (depth) => {
                    set({ researchDepth: depth }, undefined, "setResearchDepth");
                },

                setSearchMode: (mode) => {
                    set({ searchMode: mode }, undefined, "setSearchMode");
                },

                setSearchQuery: (query) => {
                    set({ searchQuery: query }, undefined, "setSearchQuery");
                },

                setSelectedModel: (model, threadId) => {
                    set(
                        {
                            selectedModel: model,
                            selectedModelThreadId: threadId,
                            userChangedModel: true,
                        },
                        undefined,
                        "setSelectedModel",
                    );
                },

                setSelectedModelsForComparison: (models) => {
                    set({ selectedModelsForComparison: models.slice(0, MAX_COMPARISON_MODELS) }, undefined, "setSelectedModelsForComparison");
                },

                setShowFavoritesOnly: (show) => {
                    set({ showFavoritesOnly: show }, undefined, "setShowFavoritesOnly");
                },

                setShowFilters: (show) => {
                    set({ showFilters: show }, undefined, "setShowFilters");
                },

                setVideoSettings: (settings) => {
                    set(
                        (state) => {
                            return {
                                videoSettings: { ...state.videoSettings, ...settings },
                            };
                        },
                        undefined,
                        "setVideoSettings",
                    );
                },

                syncModeFromThread: (mode, threadId) => {
                    set(
                        (state) => {
                            if (!threadId) {
                                return state;
                            }

                            const newThreadModes = new Map(state.threadModes);

                            newThreadModes.set(threadId, mode);

                            return {
                                currentModeThreadId: threadId,
                                threadModes: newThreadModes,
                                userChangedMode: false,
                            };
                        },
                        undefined,
                        "syncModeFromThread",
                    );
                },

                syncModelFromThread: (model, threadId) => {
                    set(
                        {
                            selectedModel: model,
                            selectedModelThreadId: threadId,
                            userChangedModel: false,
                        },
                        undefined,
                        "syncModelFromThread",
                    );
                },

                toggleCinemaPanel: () => {
                    set(
                        (state) => {
                            return { cinemaPanelOpen: !state.cinemaPanelOpen };
                        },
                        undefined,
                        "toggleCinemaPanel",
                    );
                },

                toggleFilter: (capability) => {
                    set(
                        (state) => {
                            const hasCapability = state.activeFilters.has(capability);

                            if (hasCapability && state.activeFilters.size === 1) {
                                return state;
                            }

                            const next = new Set(state.activeFilters);

                            if (hasCapability) {
                                next.delete(capability);
                            } else {
                                next.add(capability);
                            }

                            return { activeFilters: next };
                        },
                        undefined,
                        "toggleFilter",
                    );
                },

                toggleModelForComparison: (model) => {
                    set(
                        (state) => {
                            const isSelected = state.selectedModelsForComparison.includes(model);

                            if (isSelected) {
                                return { selectedModelsForComparison: state.selectedModelsForComparison.filter((m) => m !== model) };
                            }

                            if (state.selectedModelsForComparison.length >= MAX_COMPARISON_MODELS) {
                                return state;
                            }

                            return { selectedModelsForComparison: [...state.selectedModelsForComparison, model] };
                        },
                        undefined,
                        "toggleModelForComparison",
                    );
                },
            };
        }),
        { enabled: process.env.NODE_ENV === "development", name: "model-store" },
    ),
);

// ============================================================================
// Stable Selector Functions
// Define outside components for stable references
// ============================================================================

// State selectors
export const selectSelectedModel = (state: ModelStore) => state.selectedModel;
export const selectSelectedModelThreadId = (state: ModelStore) => state.selectedModelThreadId;
export const selectUserChangedModel = (state: ModelStore) => state.userChangedModel;
export const selectActualDefaultModel = (state: ModelStore) => state.actualDefaultModel;
export const selectOpen = (state: ModelStore) => state.open;
export const selectSearchQuery = (state: ModelStore) => state.searchQuery;
export const selectActiveFilters = (state: ModelStore) => state.activeFilters;
export const selectShowFavoritesOnly = (state: ModelStore) => state.showFavoritesOnly;
export const selectShowFilters = (state: ModelStore) => state.showFilters;
export const selectPendingSettings = (state: ModelStore) => state.pendingSettings;
export const selectThreadModes = (state: ModelStore) => state.threadModes;
export const selectNewThreadMode = (state: ModelStore) => state.newThreadMode;
export const selectCurrentModeThreadId = (state: ModelStore) => state.currentModeThreadId;
export const selectUserChangedMode = (state: ModelStore) => state.userChangedMode;
export const selectSearchMode = (state: ModelStore) => state.searchMode;
export const selectResearchDepth = (state: ModelStore) => state.researchDepth;
export const selectImageSettings = (state: ModelStore) => state.imageSettings;
export const selectVideoSettings = (state: ModelStore) => state.videoSettings;
export const selectAudioSettings = (state: ModelStore) => state.audioSettings;
export const selectMCPServerNames = (state: ModelStore) => state.mcpServerNames;
export const selectReferenceImageIds = (state: ModelStore) => state.referenceImageIds;

// Action selectors
export const selectLoadThreadData = (state: ModelStore) => state.loadThreadData;
export const selectSetSelectedModel = (state: ModelStore) => state.setSelectedModel;
export const selectSyncModelFromThread = (state: ModelStore) => state.syncModelFromThread;
export const selectResetForNewThread = (state: ModelStore) => state.resetForNewThread;
export const selectSetOpen = (state: ModelStore) => state.setOpen;
export const selectSetSearchQuery = (state: ModelStore) => state.setSearchQuery;
export const selectSetActiveFilters = (state: ModelStore) => state.setActiveFilters;
export const selectToggleFilter = (state: ModelStore) => state.toggleFilter;
export const selectClearFilters = (state: ModelStore) => state.clearFilters;
export const selectSetPendingSettings = (state: ModelStore) => state.setPendingSettings;
export const selectGetPendingSettings = (state: ModelStore) => state.getPendingSettings;
export const selectSetComposerMode = (state: ModelStore) => state.setComposerMode;
export const selectGetComposerMode = (state: ModelStore) => state.getComposerMode;
export const selectSyncModeFromThread = (state: ModelStore) => state.syncModeFromThread;
export const selectSetSearchMode = (state: ModelStore) => state.setSearchMode;
export const selectSetResearchDepth = (state: ModelStore) => state.setResearchDepth;
export const selectSetImageSettings = (state: ModelStore) => state.setImageSettings;
export const selectSetVideoSettings = (state: ModelStore) => state.setVideoSettings;
export const selectResetGenerationSettings = (state: ModelStore) => state.resetGenerationSettings;
export const selectSetMCPServerNames = (state: ModelStore) => state.setMCPServerNames;
export const selectSetReferenceImageIds = (state: ModelStore) => state.setReferenceImageIds;
export const selectClearReferenceImages = (state: ModelStore) => state.clearReferenceImages;

// Comparison mode selectors
export const selectComparisonMode = (state: ModelStore) => state.comparisonMode;
export const selectSelectedModelsForComparison = (state: ModelStore) => state.selectedModelsForComparison;
export const selectSetComparisonMode = (state: ModelStore) => state.setComparisonMode;
export const selectSetSelectedModelsForComparison = (state: ModelStore) => state.setSelectedModelsForComparison;
export const selectClearComparisonSelection = (state: ModelStore) => state.clearComparisonSelection;
