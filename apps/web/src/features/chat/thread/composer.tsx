"use client";

/**
 * Composer v2 - Full-featured message composer
 *
 * Uses ComposerBase for the container structure and integrates:
 * - ComposerInput (text input, attachments, submit/cancel)
 * - Slash commands (/model, /prompt)
 * - Model selector
 * - Language selector
 * - Follow-up suggestions
 * - Variable autocomplete
 * - Thread welcome suggestions
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReturnOf } from "@lunora/react";
import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import type { ImageSize } from "@neore/ai/models";
import type { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, FileText, Image, Mic, Video } from "lucide-react";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { FC, RefObject } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { CinemaPanel } from "@/features/chat/components/cinema-studio";
import { DEFAULT_MESSAGE_OPTS } from "@/features/chat/core/constants/query-options";
import { useChatIsEmpty, useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type {
    AudioGenerationSettings,
    ComposerMode,
    ImageGenerationSettings,
    ResearchDepth,
    SearchMode,
    VideoGenerationSettings,
} from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import PromptImprovementPanel from "@/features/chat/prompt-improvement/components/prompt-improvement-panel";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

import { ComposerBase } from "./composer-base";
import ComposerContextCount from "./composer-context-count";
import ComposerFollowupSuggestions from "./composer-followup-suggestions";
import type { ComposerInputRef } from "./composer-input";
import ComposerInput from "./composer-input";
import ComposerLanguageSelector from "./composer-language-selector";
import ComposerMCPSelector from "./composer-mcp-selector";
import ComposerModelSelector from "./composer-model-selector";
import ComposerReferencesButton from "./composer-references-button";
import ComposerResearchDepth from "./composer-research-depth";
import ComposerSearchMode from "./composer-search-mode";
import ComposerSearchSuggestions from "./composer-search-suggestions";
import ThreadWelcomeSuggestions from "./thread-welcome-suggestions";

// Shared animation config
const SLIDE_TRANSITION = { duration: 0.15, ease: "easeOut" } as const;

/** Row shapes the optimistic cache writes below patch. */
type ThreadRow = ReturnOf<typeof api.chat.functions.getThread>;
type ThreadWithData = ReturnOf<typeof api.chat.composite.getThreadWithData>;

/** Modes `updateThreadMode` persists — audio is composer-local. */
const PERSISTED_THREAD_MODES = ["text", "image", "video"] as const;

const isPersistedThreadMode = (value: string): value is (typeof PERSISTED_THREAD_MODES)[number] =>
    (PERSISTED_THREAD_MODES as ReadonlyArray<string>).includes(value);

/** Modes the composer mirrors from the selected model. */
const SYNCED_COMPOSER_MODES = ["text", "image", "video", "audio"] as const;

const isSyncedComposerMode = (value: string): value is (typeof SYNCED_COMPOSER_MODES)[number] =>
    (SYNCED_COMPOSER_MODES as ReadonlyArray<string>).includes(value);

// Lazy load mode-specific settings to reduce initial bundle size
const ComposerImageSettings = lazy(() => import("./composer-image-settings"));
const ComposerDrawPanel = lazy(() => import("./composer-draw-dialog"));
const ComposerVideoSettings = lazy(() => import("./composer-video-settings"));
const ComposerAudioSettings = lazy(() => import("./composer-audio-settings"));

interface ComposerProps {
    className?: string;
    /** Compact mode - hides bottom toolbar for minimal appearance (used by sticky bar) */
    compact?: boolean;
    initialMessage?: string;
    /** Hide welcome suggestions, follow-up suggestions, disclaimer, and prompt improvement panel */
    minimal?: boolean;

    /**
     * Override submit to fan-out to all child threads (used by comparison parent).
     * When set, normal sendMessage/sendComparisonMessage are bypassed.
     */
    onSubmitOverride?: (text: string, attachments: PendingAttachment[]) => Promise<void>;
    /** Custom placeholder for the text input (e.g. "Ask 2 models anything...") */
    placeholder?: string;
}

type ComposerModeOption = { icon: typeof FileText; id: ComposerMode; label: MessageDescriptor };

// COMPOSER_MODE_OPTIONS is a non-empty array, so [0] is always defined
const COMPOSER_MODE_OPTIONS: ComposerModeOption[] = [
    { icon: FileText, id: "text", label: msg`Text` },
    { icon: Image, id: "image", label: msg`Image` },
    { icon: Video, id: "video", label: msg`Video` },
    { icon: Mic, id: "audio", label: msg`Audio` },
];

// Mode order for cycling through with arrows / scroll
const MODES_ORDER: ComposerMode[] = ["text", "image", "video", "audio"];

// Icon accent color per mode
const MODE_ICON_COLOR: Record<ComposerMode, string> = {
    audio: "text-rose-500 dark:text-rose-400",
    image: "text-violet-500 dark:text-violet-400",
    text: "text-lime-600 dark:text-[#caff00]",
    video: "text-sky-500 dark:text-sky-400",
};

/**
 * Vertical mode switcher — lives on the left side of the input area.
 * ↑/↓ arrows (or scroll wheel) cycle through modes; clicking the icon opens a full picker.
 */
const ComposerModeSwitcher: FC<{
    disabled?: boolean;
    mode: ComposerMode;
    onModeChange: (mode: ComposerMode) => void;
}> = ({ disabled, mode, onModeChange }) => {
    const { i18n, t } = useLingui();
    const containerRef = useRef<HTMLDivElement>(null);
    const safeIndex = Math.max(0, MODES_ORDER.indexOf(mode));

    const cyclePrevious = useCallback(() => {
        const previousMode = MODES_ORDER[(safeIndex - 1 + MODES_ORDER.length) % MODES_ORDER.length];

        if (previousMode) {
            onModeChange(previousMode);
        }
    }, [safeIndex, onModeChange]);

    const cycleNext = useCallback(() => {
        const nextMode = MODES_ORDER[(safeIndex + 1) % MODES_ORDER.length];

        if (nextMode) {
            onModeChange(nextMode);
        }
    }, [safeIndex, onModeChange]);

    // Passive-false wheel listener so we can prevent page scroll
    useEffect(() => {
        const element = containerRef.current;

        if (!element) {
            return undefined;
        }

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();

            if (e.deltaY > 0) {
                cycleNext();
            } else {
                cyclePrevious();
            }
        };

        element.addEventListener("wheel", onWheel, { passive: false });

        return () => element.removeEventListener("wheel", onWheel);
    }, [cyclePrevious, cycleNext]);

    const currentOption = (COMPOSER_MODE_OPTIONS.find((opt) => opt.id === mode) ?? COMPOSER_MODE_OPTIONS[0]) as ComposerModeOption;
    const CurrentIcon = currentOption.icon;
    const modeLabel = i18n._(currentOption.label);

    return (
        <DropdownMenu>
            <div className="flex w-7 flex-col items-center justify-between py-1.5" ref={containerRef}>
                {/* Up arrow — previous mode */}
                <button
                    aria-label={t`Previous output mode`}
                    className="text-muted-foreground/40 hover:text-muted-foreground flex size-4 items-center justify-center rounded transition-colors"
                    disabled={disabled}
                    onClick={cyclePrevious}
                    type="button"
                >
                    <ChevronUp aria-hidden="true" className="size-3" />
                </button>

                {/* Current mode icon — click to open full picker */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <DropdownMenuTrigger
                                disabled={disabled}
                                render={
                                    <button
                                        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                                        type="button"
                                    >
                                        <CurrentIcon className={cn("size-3.5 shrink-0", MODE_ICON_COLOR[mode])} />
                                    </button>
                                }
                            />
                        }
                    />
                    <TooltipContent side="right" sideOffset={10}>
                        <p>{t`${modeLabel} mode — click to change`}</p>
                    </TooltipContent>
                </Tooltip>

                {/* Down arrow — next mode */}
                <button
                    aria-label={t`Next output mode`}
                    className="text-muted-foreground/40 hover:text-muted-foreground flex size-4 items-center justify-center rounded transition-colors"
                    disabled={disabled}
                    onClick={cycleNext}
                    type="button"
                >
                    <ChevronDown aria-hidden="true" className="size-3" />
                </button>
            </div>

            <DropdownMenuContent align="start" className="min-w-[160px] p-1.5" side="right" sideOffset={6}>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-semibold">{t`Output Mode`}</div>
                {COMPOSER_MODE_OPTIONS.map(({ icon: Icon, id, label }) => (
                    <DropdownMenuItem className="gap-2.5 py-2" key={id} onClick={() => onModeChange(id)}>
                        <Icon className={cn("size-4 shrink-0", MODE_ICON_COLOR[id])} />
                        <span className="font-medium">{i18n._(label)}</span>
                        {mode === id && <Check className="text-muted-foreground ml-auto size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

const CYCLING_PLACEHOLDER_INTERVAL_MS = 4000;

/** Cycles through a set of example prompts when the composer has no explicit placeholder. */
const useCyclingPlaceholder = (): string => {
    const { t } = useLingui();
    const placeholders = [
        t`Ask me anything...`,
        t`Write some code for me...`,
        t`Summarize a document or URL...`,
        t`Plan a project or brainstorm ideas...`,
        t`Draft an email, report, or essay...`,
        t`Research a topic in depth...`,
        t`Debug an error or review my code...`,
        t`Explain a concept in simple terms...`,
        t`Translate text to another language...`,
        t`Generate an image or video...`,
    ];
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const id = setInterval(() => setIndex((i) => (i + 1) % placeholders.length), CYCLING_PLACEHOLDER_INTERVAL_MS);

        return () => clearInterval(id);
    }, [placeholders.length]);

    return placeholders[index] ?? "";
};

/**
 * Internal composer input that's wrapped by slash commands.
 */
const ComposerInputWrapper: FC<{
    compact?: boolean;
    disabled?: boolean;
    inputRef?: RefObject<ComposerInputRef | null>;
    onOpenDraw?: () => void;
    onSubmit: () => void;
    onSubmitOverride?: (text: string, attachments: PendingAttachment[]) => Promise<void>;
    placeholder?: string;
}> = ({ compact, disabled, inputRef, onOpenDraw, onSubmit, onSubmitOverride, placeholder }) => {
    const cyclingPlaceholder = useCyclingPlaceholder();

    return (
        <ComposerInput
            autoFocus
            compact={compact}
            data-composer-input
            disabled={disabled}
            maxRows={5}
            onOpenDraw={onOpenDraw}
            onSubmit={onSubmit}
            onSubmitOverride={onSubmitOverride}
            placeholder={placeholder ?? cyclingPlaceholder}
            ref={inputRef}
        />
    );
};

const Composer: FC<ComposerProps> = ({ className, compact = false, initialMessage, minimal = false, onSubmitOverride, placeholder }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const [isDrawOpen, setIsDrawOpen] = useState(false);
    const composerInputRef = useRef<ComposerInputRef>(null);

    const handleDrawComplete = useCallback((file: File) => {
        composerInputRef.current?.addFile(file);
    }, []);
    const { isNewThread, threadId } = useChatThread();
    const validThreadId = getValidThreadId(threadId);
    const isEmpty = useChatIsEmpty();
    const { isStreaming, sseStreamState } = useChatIsStreaming();
    // Disable input while SSE streaming is in progress to prevent message loss
    const isSSEStreaming = !!sseStreamState;

    // favoriteModelIds is handled by the tiptap editor internally
    useFavoriteModels();
    const { data: userSettings } = useUserSettings();
    const { isAnonymous } = useIsAnonymous();
    const currentModel = useCurrentModel();
    const flaggedModels = useFeatureFlaggedModels();
    // isSubmitting is read in render output (hides follow-up suggestions while submitting).
    // setComposerText and setIsSubmitting are only called from effects/callbacks,
    // so access them via getState() to avoid unnecessary re-renders (rerender-defer-reads).
    const isSubmitting = useChatUIStore((state) => state.isSubmitting);
    const lastInitialMessage = useRef<string | undefined>(undefined);

    // Mutation to save mode to Lunora with optimistic updates (only used for new threads)
    const { mutate: updateThreadMode } = useMutation({
        ...crpc.chat.functions.updateThreadMode.mutationOptions(),
        onMutate: async ({ mode: newMode, threadId: mutationThreadId }) => {
            // Cancel outgoing refetches
            await queryClient.cancelQueries({
                queryKey: crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }),
            });

            // Snapshot previous value
            const previousThread = queryClient.getQueryData(crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }));

            // Optimistically update getThread cache
            queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }), (old: ThreadRow) =>
                old ? { ...old, mode: newMode } : old,
            );

            // Also update the composite query cache if it exists
            queryClient.setQueryData(
                // Key derived from the reference; the hand-written literal matched nothing
                // under Lunora, so this optimistic write was never read back.
                crpc.chat.composite.getThreadWithData.queryKey({ messageOpts: DEFAULT_MESSAGE_OPTS, threadId: mutationThreadId as Id<"threads"> }),
                (old: ThreadWithData) => {
                    const thread = old?.thread;

                    return thread ? { ...old, thread: { ...thread, mode: newMode } } : old;
                },
            );

            return { previousThread };
        },
        onError: (_error, variables, context: { previousThread?: unknown } | undefined) => {
            // Rollback on error
            if (context?.previousThread) {
                queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: variables.threadId }), context.previousThread);
            }
        },
    });

    // Only subscribe to searchMode and researchDepth - these are the model store values used in render
    const searchMode = useModelStore((state) => state.searchMode);
    const researchDepth = useModelStore((state) => state.researchDepth);

    // Get mode-specific settings only when needed (prevents re-renders when other modes' settings change)
    const imageSettings = useModelStore((state) => state.imageSettings);
    const videoSettings = useModelStore((state) => state.videoSettings);
    const audioSettings = useModelStore((state) => state.audioSettings);

    // Access actions directly via getState() to avoid subscribing to them
    const setComposerMode = useCallback((mode: ComposerMode, tid?: string | undefined, userChanged?: boolean) => {
        useModelStore.getState().setComposerMode(mode, tid, userChanged);
    }, []);
    const setSearchMode = useCallback((mode: SearchMode) => {
        useModelStore.getState().setSearchMode(mode);
    }, []);
    const setResearchDepth = useCallback((depth: ResearchDepth) => {
        useModelStore.getState().setResearchDepth(depth);
    }, []);
    const setSelectedModel = useCallback((modelId: string, tid?: string | undefined) => {
        useModelStore.getState().setSelectedModel(modelId, tid);
    }, []);
    const setImageSettings = useCallback((settings: Partial<ImageGenerationSettings>) => {
        useModelStore.getState().setImageSettings(settings);
    }, []);
    const setVideoSettings = useCallback((settings: Partial<VideoGenerationSettings>) => {
        useModelStore.getState().setVideoSettings(settings);
    }, []);
    const setAudioSettings = useCallback((settings: Partial<AudioGenerationSettings>) => {
        useModelStore.getState().setAudioSettings(settings);
    }, []);

    // Get mode from thread data (source of truth) or store (for new threads or user changes)
    const { thread } = useChatThread();
    const storeNewThreadMode = useModelStore((state) => state.newThreadMode);
    const storeUserChangedMode = useModelStore((state) => state.userChangedMode && state.currentModeThreadId === threadId);
    const storeThreadMode = useModelStore((state) => state.threadModes.get(threadId || ""));

    const composerMode = useMemo((): ComposerMode => {
        if (isNewThread || !threadId) {
            return storeNewThreadMode;
        }

        // If user explicitly changed mode for this thread, use store value
        if (storeUserChangedMode) {
            return storeThreadMode || "text";
        }

        // Otherwise use thread's persisted mode
        const mode = (thread?.mode as ComposerMode) || "text";

        return mode;
    }, [isNewThread, threadId, storeNewThreadMode, storeUserChangedMode, storeThreadMode, thread?.mode]);

    const isEnableFollowupSuggestions = userSettings?.enableFollowupSuggestions !== false;
    const prefersReducedMotion = useReducedMotion();

    // Get model mode and default models (memoized together since they share the same data source)
    const { defaultModelsByMode, isAudioModel, isImageModel, isVideoModel, maxReferenceImages, modelAspectRatios, modelMode, supportsNegativePrompt } =
        useMemo(() => {
            const modelDefinition = flaggedModels.find((candidate) => candidate.id === (currentModel as unknown as string));
            const mode = modelDefinition?.mode || "text";

            const textModel = flaggedModels.find((candidate) => candidate.enabled && (candidate.mode === "text" || !candidate.mode));
            const imageModel = flaggedModels.find((candidate) => candidate.enabled && candidate.mode === "image");
            const videoModel = flaggedModels.find((candidate) => candidate.enabled && candidate.mode === "video");
            const audioModel = flaggedModels.find((candidate) => candidate.enabled && candidate.mode === "speech-to-text");

            return {
                defaultModelsByMode: {
                    audio: audioModel?.id,
                    image: imageModel?.id,
                    text: textModel?.id,
                    video: videoModel?.id,
                },
                isAudioModel: mode === "speech-to-text",
                isImageModel: mode === "image",
                isVideoModel: mode === "video",
                maxReferenceImages: modelDefinition?.maxReferenceImages ?? 0,
                modelAspectRatios: modelDefinition?.aspectRatios as ReadonlyArray<string> | undefined,
                modelMode: mode === "speech-to-text" ? "audio" : mode,
                supportsNegativePrompt: modelDefinition?.supportsNegativePrompt ?? false,
            };
        }, [currentModel, flaggedModels]);

    // When the model changes, reset aspectRatio if the current value isn't supported
    useEffect(() => {
        if (!modelAspectRatios) {
            return;
        }

        const current = useModelStore.getState().imageSettings.aspectRatio;

        if (!modelAspectRatios.includes(current)) {
            useModelStore.getState().setImageSettings({ aspectRatio: modelAspectRatios[0] as ImageSize });
        }
    }, [modelAspectRatios]);

    // When the model loses reference-image support (or the cap shrinks), clamp the
    // attached references so we never carry a stale over-cap selection into send.
    // Switching to non-image mode also clears them — references are an image-mode-only
    // concept and would be silently dropped by the send pipeline otherwise.
    useEffect(() => {
        const cap = isImageModel ? maxReferenceImages : 0;
        const { attachedReferences, setAttachedReferences } = useChatUIStore.getState();

        if (attachedReferences.length > cap) {
            setAttachedReferences(attachedReferences.slice(0, cap));
        }
    }, [isImageModel, maxReferenceImages]);

    // Handle mode change - switch model if current model doesn't match the new mode
    const handleModeChange = useCallback(
        (newMode: ComposerMode) => {
            setComposerMode(newMode, threadId);

            // Save mode to Lunora if we have a valid thread
            if (validThreadId && isPersistedThreadMode(newMode)) {
                updateThreadMode({ mode: newMode, threadId: validThreadId });
            }

            // Check if current model matches the new mode
            const currentModelDef = flaggedModels.find((candidate) => candidate.id === (currentModel as unknown as string));
            const rawModelMode = currentModelDef?.mode || "text";
            // Normalize speech-to-text to audio for comparison
            const currentModelMode: string = rawModelMode === "speech-to-text" ? "audio" : rawModelMode;

            // Normalize the new mode for comparison
            const normalizedNewMode = newMode === "audio" ? "audio" : newMode;

            // If current model doesn't match new mode, switch to default model for that mode
            if (currentModelMode !== normalizedNewMode) {
                // For anonymous users switching back to text mode, always use the free model
                const defaultModel = isAnonymous && newMode === "text" ? ANONYMOUS_FREE_MODEL : defaultModelsByMode[newMode];

                if (defaultModel) {
                    setSelectedModel(defaultModel, threadId);
                }
            }
        },
        [currentModel, defaultModelsByMode, flaggedModels, isAnonymous, setComposerMode, setSelectedModel, threadId, validThreadId, updateThreadMode],
    );

    // Auto-sync composer mode when the USER explicitly picks a different model
    // (e.g., user picks an image model on a text thread → mode switches to image)
    // On initial mount / thread switch, loadThreadData already set the correct mode,
    // so we must NOT overwrite it here.
    const previousModelModeRef = useRef(modelMode);

    useEffect(() => {
        if (isSyncedComposerMode(modelMode)) {
            const isUserInitiated = useModelStore.getState().userChangedModel;

            // Only sync mode when the user explicitly changed the model.
            // Skip on thread load — loadThreadData already set the correct mode.
            if (isUserInitiated) {
                setComposerMode(modelMode, threadId, true);

                if (previousModelModeRef.current !== modelMode && validThreadId && isPersistedThreadMode(modelMode)) {
                    updateThreadMode({ mode: modelMode, threadId: validThreadId });
                }
            }
        }

        previousModelModeRef.current = modelMode;
    }, [modelMode, setComposerMode, threadId, validThreadId, updateThreadMode]);

    // For anonymous users in text mode, ensure the store uses the free model
    // so the displayed model and the actually-used model are consistent
    useEffect(() => {
        if (!isAnonymous) {
            return;
        }

        const state = useModelStore.getState();
        const currentModeInStore = state.getComposerMode(threadId);

        if (currentModeInStore === "text" && !state.userChangedModel && (state.selectedModel as unknown as string) !== ANONYMOUS_FREE_MODEL) {
            // Use syncModelFromThread so userChangedModel stays false (this is an auto-init, not a user choice)
            state.syncModelFromThread(ANONYMOUS_FREE_MODEL, threadId);
        }
    }, [isAnonymous, threadId]);

    // Set initial message when component mounts or initialMessage changes
    useEffect(() => {
        if (initialMessage && initialMessage !== lastInitialMessage.current) {
            useChatUIStore.getState().setComposerText(initialMessage);
            lastInitialMessage.current = initialMessage;
        } else if (!initialMessage) {
            lastInitialMessage.current = undefined;
        }
    }, [initialMessage]);

    // Clear submitting state when SSE streaming starts
    useEffect(() => {
        if (isSSEStreaming && isSubmitting) {
            useChatUIStore.getState().setIsSubmitting(false);
        }
    }, [isSSEStreaming, isSubmitting]);

    const renderModeSettings = () => {
        if (composerMode === "image") {
            return (
                <m.div
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    initial={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    key="image-settings"
                    transition={{ duration: 0.15, ease: "easeOut" }}
                >
                    <Suspense fallback={<div className="h-7 w-32 animate-pulse rounded bg-gray-100 dark:bg-neutral-800" />}>
                        <ComposerImageSettings
                            disabled={isSSEStreaming}
                            onSettingsChange={setImageSettings}
                            settings={imageSettings}
                            supportedAspectRatios={modelAspectRatios}
                            supportsNegativePrompt={supportsNegativePrompt}
                        />
                    </Suspense>
                </m.div>
            );
        }

        if (composerMode === "video") {
            return (
                <m.div
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    initial={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    key="video-settings"
                    transition={{ duration: 0.15, ease: "easeOut" }}
                >
                    <Suspense fallback={<div className="h-7 w-32 animate-pulse rounded bg-gray-100 dark:bg-neutral-800" />}>
                        <ComposerVideoSettings disabled={isSSEStreaming} onSettingsChange={setVideoSettings} settings={videoSettings} />
                    </Suspense>
                </m.div>
            );
        }

        if (composerMode === "audio") {
            return (
                <m.div
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    initial={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                    key="audio-settings"
                    transition={{ duration: 0.15, ease: "easeOut" }}
                >
                    <Suspense fallback={<div className="h-7 w-32 animate-pulse rounded bg-gray-100 dark:bg-neutral-800" />}>
                        <ComposerAudioSettings disabled={isSSEStreaming} onSettingsChange={setAudioSettings} settings={audioSettings} />
                    </Suspense>
                </m.div>
            );
        }

        return null;
    };

    return (
        <LazyMotion features={domAnimation}>
            <div className={cn("relative w-full", className)}>
                {/* Disclaimer */}
                {!minimal && (
                    <div className="text-foreground absolute top-full w-full pt-2 text-center text-xs">{t`Neore can make mistakes. Check important information.`}</div>
                )}

                {/* Mode-specific content above composer with animations */}
                <AnimatePresence mode="popLayout">
                    {composerMode === "text" && !isDrawOpen && (
                        <m.div
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 20 }}
                            initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
                            key="text-suggestions"
                            transition={SLIDE_TRANSITION}
                        >
                            {/* Welcome suggestions for empty threads */}
                            {!minimal && isEmpty && <ThreadWelcomeSuggestions className="-mb-5 pb-5.5" key={threadId} />}

                            {/* Followup suggestions - only for text mode, hide while streaming or regenerating */}
                            {!minimal && isEnableFollowupSuggestions && !isImageModel && !isVideoModel && !isAudioModel && !isStreaming && !isSubmitting && (
                                <ComposerFollowupSuggestions />
                            )}

                            {/* Search suggestions while typing - only in search modes */}
                            {composerMode === "text" && searchMode !== "chat" && !isStreaming && !isSubmitting && <ComposerSearchSuggestions />}

                            {/* Prompt improvement panel */}
                            <PromptImprovementPanel className="-mb-2 pb-3" />
                        </m.div>
                    )}
                </AnimatePresence>

                {/* Inline draw panel — slides in below suggestions, above the input */}
                <AnimatePresence>
                    {isDrawOpen && (
                        <m.div
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-2"
                            exit={{ opacity: 0, y: -8 }}
                            initial={prefersReducedMotion ? undefined : { opacity: 0, y: -8 }}
                            key="draw-panel"
                            transition={SLIDE_TRANSITION}
                        >
                            <Suspense fallback={<div className="bg-muted h-64 w-full animate-pulse rounded-lg" />}>
                                <ComposerDrawPanel onClose={() => setIsDrawOpen(false)} onDraw={handleDrawComplete} />
                            </Suspense>
                        </m.div>
                    )}
                </AnimatePresence>

                {/* Cinema Panel - rendered above mode settings for image/video */}
                {(composerMode === "image" || composerMode === "video") && (
                    <CinemaPanel
                        onChange={(cinema) => {
                            if (composerMode === "image") {
                                setImageSettings({ cinema });
                            } else {
                                setVideoSettings({ cinema });
                            }
                        }}
                        value={(composerMode === "image" ? imageSettings.cinema : videoSettings.cinema) || { enabled: true }}
                    />
                )}

                {/* Main composer using ComposerBase */}
                <ComposerBase
                    bottomToolbar={
                        <>
                            <ComposerModelSelector />

                            {/* Search mode - only for text mode */}
                            <AnimatePresence mode="popLayout">
                                {composerMode === "text" && (
                                    <m.div
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.9 }}
                                        initial={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.9 }}
                                        key="search-mode"
                                        transition={SLIDE_TRANSITION}
                                    >
                                        <ComposerSearchMode disabled={isSSEStreaming} mode={searchMode} onModeChange={setSearchMode} />
                                    </m.div>
                                )}
                            </AnimatePresence>
                            {/* Research depth - only when a search mode is active */}
                            <AnimatePresence mode="popLayout">
                                {composerMode === "text" && searchMode !== "chat" && (
                                    <m.div
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.9 }}
                                        initial={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.9 }}
                                        key="research-depth"
                                        transition={SLIDE_TRANSITION}
                                    >
                                        <ComposerResearchDepth depth={researchDepth} disabled={isSSEStreaming} onDepthChange={setResearchDepth} />
                                    </m.div>
                                )}
                            </AnimatePresence>
                            {/* MCP server selector - only for text mode */}
                            <AnimatePresence mode="popLayout">
                                {composerMode === "text" && (
                                    <m.div
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.9 }}
                                        initial={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.9 }}
                                        key="mcp-selector"
                                        transition={SLIDE_TRANSITION}
                                    >
                                        <ComposerMCPSelector disabled={isSSEStreaming} />
                                    </m.div>
                                )}
                            </AnimatePresence>
                            {/* Reference images picker - only for image models that support reference inputs */}
                            <AnimatePresence mode="popLayout">
                                {composerMode === "image" && maxReferenceImages > 0 && (
                                    <m.div
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.9 }}
                                        initial={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.9 }}
                                        key="references-picker"
                                        transition={SLIDE_TRANSITION}
                                    >
                                        <ComposerReferencesButton disabled={isSSEStreaming} maxReferenceImages={maxReferenceImages} threadId={validThreadId} />
                                    </m.div>
                                )}
                            </AnimatePresence>
                            <div className="grow" />
                            <ComposerContextCount />
                            <ComposerLanguageSelector />
                        </>
                    }
                    compact={compact}
                    leftPanel={
                        !compact && !validThreadId ? (
                            <ComposerModeSwitcher disabled={isSSEStreaming} mode={composerMode} onModeChange={handleModeChange} />
                        ) : undefined
                    }
                    mode={composerMode}
                    modeSettings={composerMode === "text" ? null : <AnimatePresence mode="wait">{renderModeSettings()}</AnimatePresence>}
                >
                    <ComposerInputWrapper
                        compact={compact}
                        // The thread composer stays editable while a turn streams —
                        // submitting then QUEUES (see ComposerPromptQueue). The
                        // comparison fan-out has no queue, so it still locks.
                        disabled={isSSEStreaming && !!onSubmitOverride}
                        inputRef={composerInputRef}
                        onOpenDraw={compact ? undefined : () => setIsDrawOpen(true)}
                        onSubmit={() => {}}
                        onSubmitOverride={onSubmitOverride}
                        placeholder={placeholder}
                    />
                </ComposerBase>
            </div>
        </LazyMotion>
    );
};

export default Composer;
