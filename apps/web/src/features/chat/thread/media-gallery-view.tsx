"use client";

/**
 * MediaGalleryView - Full gallery view for image/video generation mode
 *
 * Replaces MessageList when in image or video mode.
 * Displays all generated images/videos from the conversation in a gallery grid.
 * Supports preview dialog for viewing and regenerating media.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ImageSize } from "@neore/ai/models";
import { Button } from "@neore/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@neore/ui/components/collapsible";
import type { GalleryItem } from "@neore/ui/components/image-gallery";
import { ImageGallery, ImageGalleryKreaGrid } from "@neore/ui/components/image-gallery";
import { Label } from "@neore/ui/components/label";
import type { MediaItem } from "@neore/ui/components/media-preview-dialog";
import {
    MediaPreviewDialog,
    MediaPreviewDialogContent,
    MediaPreviewDialogFooter,
    MediaPreviewPanel,
    MediaPreviewSettingsPanel,
} from "@neore/ui/components/media-preview-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Slider } from "@neore/ui/components/slider";
import { Textarea } from "@neore/ui/components/textarea";
import cn from "@neore/ui/utils/cn";
import { ImageIcon, Sparkles, VideoIcon, X } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";

import { CinemaStudioControls } from "@/features/chat/components/cinema-studio";
import { useChatIsStreaming, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ComposerMode } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

// Skeleton cell indices — hoisted so the array is never recreated in JSX
const SKELETON_INDICES = [0, 1, 2, 3] as const;

// Image aspect ratio options
const IMAGE_ASPECT_RATIOS: { description: MessageDescriptor; label: string; value: ImageSize }[] = [
    { description: msg`Square`, label: "1:1", value: "1:1" },
    { description: msg`Portrait (standard)`, label: "3:4", value: "3:4" },
    { description: msg`Portrait (photo)`, label: "2:3", value: "2:3" },
    { description: msg`Portrait (tall)`, label: "9:16", value: "9:16" },
    { description: msg`Landscape (photo)`, label: "3:2", value: "3:2" },
    { description: msg`Landscape (standard)`, label: "4:3", value: "4:3" },
    { description: msg`Cinematic`, label: "16:9", value: "16:9" },
    { description: msg`Cinematic (ultra-wide)`, label: "21:9", value: "21:9" },
];

const QUALITY_OPTIONS: { label: MessageDescriptor | string; value: "standard" | "hd" }[] = [
    { label: msg`Standard`, value: "standard" },
    { label: "HD", value: "hd" },
];

const STYLE_OPTIONS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Auto`, value: "" },
    { label: msg`Vivid`, value: "vivid" },
    { label: msg`Natural`, value: "natural" },
    { label: msg`Anime`, value: "anime" },
    { label: msg`Photographic`, value: "photographic" },
    { label: msg`Digital Art`, value: "digital-art" },
    { label: msg`Cinematic`, value: "cinematic" },
];

// Video aspect ratio options (model-specific - see FAL_VIDEO_MODELS config)
const VIDEO_ASPECT_RATIOS: { description: MessageDescriptor; label: string; value: string }[] = [
    { description: msg`Landscape (wide)`, label: "16:9", value: "16:9" },
    { description: msg`Portrait (tall)`, label: "9:16", value: "9:16" },
    { description: msg`Square`, label: "1:1", value: "1:1" },
    { description: msg`Landscape (standard)`, label: "4:3", value: "4:3" },
    { description: msg`Portrait (standard)`, label: "3:4", value: "3:4" },
];

const DURATION_MARKS = [3, 5, 10, 15, 30, 60];

/** Visual preview of aspect ratio, rendered inside each SelectItem. */
const AspectRatioPreview: FC<{ ratio: string }> = ({ ratio }) => {
    const parts = ratio.replace("-hd", "").split(":");
    const w = Number(parts[0]) || 1;
    const h = Number(parts[1]) || 1;
    const baseSize = 12;

    let width = baseSize;
    let height = baseSize;

    if (w > h) {
        height = Math.round((baseSize * h) / w);
    } else if (h > w) {
        width = Math.round((baseSize * w) / h);
    }

    return <div className="border-muted-foreground/50 rounded-sm border" style={{ height, width }} />;
};

interface MediaGalleryViewProps {
    className?: string;
    maxWidth?: string;
}

/**
 * Full gallery view component for image/video mode.
 */
const MediaGalleryView: FC<MediaGalleryViewProps> = ({ className, maxWidth = "65ch" }) => {
    const { i18n, t } = useLingui();
    const models = useFeatureFlaggedModels();
    const modelsMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
    const { messages } = useChatMessages();
    const { isStreaming } = useChatIsStreaming();
    const { isNewThread, thread, threadId } = useChatThread();
    const setComposerText = useChatUIStore((state) => state.setComposerText);

    // Get mode from thread data (source of truth) or store (for new threads or user changes)
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
        return (thread?.mode as ComposerMode) || "text";
    }, [isNewThread, threadId, storeNewThreadMode, storeUserChangedMode, storeThreadMode, thread?.mode]);
    const imageSettings = useModelStore((state) => state.imageSettings);
    const videoSettings = useModelStore((state) => state.videoSettings);
    const setImageSettings = useModelStore((state) => state.setImageSettings);
    const setVideoSettings = useModelStore((state) => state.setVideoSettings);

    const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [newPrompt, setNewPrompt] = useState("");

    // Multi-selection state for reference images
    const referenceImageIds = useModelStore((state) => state.referenceImageIds);
    const setReferenceImageIds = useModelStore((state) => state.setReferenceImageIds);
    const MAX_REFERENCE_IMAGES = 4;

    // Generation markers used by backend
    const IMAGE_GENERATING_MARKER = "__IMAGE_GENERATING__";
    const VIDEO_GENERATING_MARKER = "__VIDEO_GENERATING__";

    // Check if there's a pending generation (message with __IMAGE_GENERATING__ or __VIDEO_GENERATING__ marker)
    const isGenerating = useMemo(() => {
        for (const message of messages) {
            if (message.role !== "assistant") {
                continue;
            }

            for (const part of message.parts) {
                if (part.type !== "text") {
                    continue;
                }

                const textPart = part as { text: string; type: "text" };

                if (textPart.text === IMAGE_GENERATING_MARKER || textPart.text === VIDEO_GENERATING_MARKER) {
                    return true;
                }
            }
        }

        return false;
    }, [messages]);

    // Extract generated images/videos from messages
    const galleryItems = useMemo((): GalleryItem[] => {
        const items: GalleryItem[] = [];
        let lastUserPrompt: string | undefined;

        for (const message of messages) {
            // Track the last user message text so we can use it as the prompt
            // for subsequent image/video generation (metadata.prompt may not be set
            // if the pending message's metadata wins in the group aggregation)
            if (message.role === "user") {
                // Single-pass extraction: skip filter+map+join, combine into one loop
                let textContent = "";

                for (const p of message.parts as { text?: string; type: string }[]) {
                    if (p.type === "text" && p.text) {
                        textContent += (textContent ? " " : "") + p.text;
                    }
                }

                if (textContent) {
                    lastUserPrompt = textContent;
                }

                continue;
            }

            if (message.role !== "assistant") {
                continue;
            }

            const prompt = (message.metadata as { prompt?: string } | undefined)?.prompt || lastUserPrompt;
            const rawModel = message.model;
            // O(1) lookup via pre-built Map instead of O(n) .find() per message
            const modelDefinition = rawModel ? modelsMap.get(rawModel) : undefined;
            const modelName = modelDefinition?.name ?? rawModel;
            // `UIMessage` has no `createdAt`; the timestamp these messages actually
            // carry is `_creationTime` (see the cache seeding in chat-context and
            // streaming-placeholder). Reading `createdAt` made this permanently
            // `undefined`, which turned the "newest first" sort below into a no-op
            // and left the lightbox with no date.
            const rawCreatedAt: unknown = (message as unknown as { _creationTime?: unknown })._creationTime;
            const createdAt = typeof rawCreatedAt === "number" || typeof rawCreatedAt === "string" ? new Date(rawCreatedAt) : undefined;

            for (const part of message.parts) {
                if (part.type !== "file") {
                    continue;
                }

                const filePart = part as { data?: string; filename?: string; mediaType?: string; nsfwStatus?: string; type: "file"; url?: string };

                if (filePart.mediaType?.startsWith("image/") && (filePart.url || filePart.data)) {
                    items.push({
                        alt: filePart.filename || t`Generated image`,
                        batchId: message.id,
                        createdAt,
                        id: `${message.id}-${items.length}`,
                        modelName,
                        nsfwStatus: filePart.nsfwStatus,
                        prompt,
                        src: filePart.url || filePart.data || "",
                        type: "image",
                    });
                } else if (filePart.mediaType?.startsWith("video/") && (filePart.url || filePart.data)) {
                    items.push({
                        alt: filePart.filename || t`Generated video`,
                        batchId: message.id,
                        createdAt,
                        id: `${message.id}-${items.length}`,
                        modelName,
                        prompt,
                        src: filePart.url || filePart.data || "",
                        type: "video",
                    });
                }
            }
        }

        // Sort by creation date, newest first (stable: batches stay together because same batchId)
        return items.toSorted((a, b) => {
            if (!a.createdAt || !b.createdAt) {
                return 0;
            }

            return b.createdAt.getTime() - a.createdAt.getTime();
        });
    }, [messages, modelsMap, t]);

    // Filter items by mode
    const filteredItems = useMemo(
        () => galleryItems.filter((item) => (composerMode === "image" ? item.type === "image" : item.type === "video")),
        [galleryItems, composerMode],
    );

    const handleItemClick = useCallback((item: GalleryItem) => {
        const mediaItem: MediaItem = {
            alt: item.alt,
            aspectRatio: item.aspectRatio,
            createdAt: item.createdAt,
            duration: item.duration,
            id: item.id,
            prompt: item.prompt,
            src: item.src,
            thumbnail: item.thumbnail,
            type: item.type,
        };

        setSelectedItem(mediaItem);
        setNewPrompt(item.prompt || "");
        setDialogOpen(true);
    }, []);

    const handleSelectionChange = useCallback(
        (ids: string[]) => {
            setReferenceImageIds(ids);
        },
        [setReferenceImageIds],
    );

    const handleClearSelection = useCallback(() => {
        setReferenceImageIds([]);
    }, [setReferenceImageIds]);

    // Get selected items data for display — Set for O(1) per-item lookup
    const selectedReferenceItems = useMemo(() => {
        const idsSet = new Set(referenceImageIds);

        return filteredItems.filter((item) => idsSet.has(item.id));
    }, [filteredItems, referenceImageIds]);

    const handleDialogClose = useCallback((open: boolean) => {
        setDialogOpen(open);

        if (!open) {
            setSelectedItem(null);
            setNewPrompt("");
        }
    }, []);

    const handleGenerate = useCallback(() => {
        if (!newPrompt.trim()) {
            return;
        }

        setDialogOpen(false);
        setSelectedItem(null);
        // Set the prompt in the composer
        setComposerText(newPrompt.trim());
        setNewPrompt("");
    }, [newPrompt, setComposerText]);

    const formatDuration = (seconds: number): string => {
        if (seconds < 60) {
            return t`${seconds}s`;
        }

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return secs > 0 ? t`${mins}m ${secs}s` : t`${mins}m`;
    };

    const isImage = composerMode === "image";
    const Icon = isImage ? ImageIcon : VideoIcon;
    const title = isImage ? t`Image Generation` : t`Video Generation`;
    const emptyTitle = isImage ? t`No images yet` : t`No videos yet`;
    const emptyDescription = isImage
        ? t`Generated images will appear here. Start by describing what you want to create in the composer below.`
        : t`Generated videos will appear here. Start by describing what you want to create in the composer below.`;

    return (
        <div className={cn("media-gallery-view flex flex-col", className)} style={{ "--thread-max-width": maxWidth } as React.CSSProperties}>
            {/* Selection indicator – sticky so it stays visible while scrolling */}
            {referenceImageIds.length > 0 && (
                <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg border border-black/[0.06] bg-zinc-50/95 px-4 py-2.5 backdrop-blur-sm dark:border-white/[0.06] dark:bg-[#1a1a1a]/95">
                    <div className="flex items-center gap-3">
                        <div className="flex -space-x-1.5">
                            {selectedReferenceItems.slice(0, 4).map((item) => (
                                <div className="border-background size-7 overflow-hidden rounded-full border-2" key={item.id}>
                                    <img alt={item.alt || t`Selected reference`} className="size-full object-cover" src={item.thumbnail || item.src} />
                                </div>
                            ))}
                        </div>
                        <span className="text-sm font-light text-zinc-600 dark:text-white/60">
                            {t`${referenceImageIds.length} of ${MAX_REFERENCE_IMAGES} references selected`}
                        </span>
                    </div>
                    <Button
                        className="text-zinc-400 hover:text-zinc-700 dark:text-white/30 dark:hover:text-white/70"
                        onClick={handleClearSelection}
                        size="sm"
                        variant="ghost"
                    >
                        <X className="mr-1 size-3.5" />
                        {t`Clear`}
                    </Button>
                </div>
            )}

            {/* Generation Loading State – Krea-style skeleton */}
            {(isGenerating || isStreaming) && (
                <div className="space-y-1">
                    <div className="grid gap-1" style={{ gridTemplateColumns: "240px 1fr" }}>
                        {/* Prompt card skeleton */}
                        <div className="min-h-[260px] animate-pulse rounded-lg border border-black/[0.08] bg-zinc-100 dark:border-white/[0.05] dark:bg-[#161616]" />
                        {/* Image cells skeleton */}
                        <div className="grid grid-cols-2 gap-1">
                            {SKELETON_INDICES.map((i) => (
                                <div
                                    className="aspect-[4/3] animate-pulse rounded-lg bg-zinc-200 dark:bg-white/[0.04]"
                                    key={i}
                                    style={{ animationDelay: `${i * 80}ms` }}
                                />
                            ))}
                        </div>
                    </div>
                    <p className="text-muted-foreground mt-3 text-center text-xs font-medium tracking-wider uppercase">
                        {isImage ? t`Generating image...` : t`Generating video...`}
                    </p>
                </div>
            )}

            {/* Gallery Content */}
            {filteredItems.length > 0 && (
                <ImageGallery
                    items={filteredItems}
                    maxSelections={MAX_REFERENCE_IMAGES}
                    onItemClick={handleItemClick}
                    onSelectionChange={handleSelectionChange}
                    selectedIds={referenceImageIds}
                    selectionEnabled={isImage}
                >
                    <ImageGalleryKreaGrid />
                </ImageGallery>
            )}
            {filteredItems.length === 0 && !isGenerating && !isStreaming && (
                // Empty state - only show when not generating
                <div className="flex flex-1 flex-col items-center justify-center">
                    <div className="relative flex flex-col items-center py-24">
                        <div className="absolute -inset-16 rounded-full bg-zinc-100 blur-3xl dark:bg-white/[0.02]" />
                        <Icon className="relative size-14 text-zinc-300 dark:text-white/10" />
                        <p className="relative mt-6 text-base font-light text-zinc-400 dark:text-white/25">{emptyTitle}</p>
                        <p className="relative mt-2 max-w-xs text-center text-sm text-zinc-300 dark:text-white/15">{emptyDescription}</p>
                    </div>
                </div>
            )}

            {/* Media Preview Dialog */}
            <MediaPreviewDialog media={selectedItem} onOpenChange={handleDialogClose} open={dialogOpen}>
                <MediaPreviewDialogContent>
                    <MediaPreviewPanel defaultSize={55} minSize={35} />
                    <MediaPreviewSettingsPanel defaultSize={45} description={t`Customize and regenerate`} minSize={30} title={title}>
                        <div className="space-y-6">
                            {/* Prompt Input */}
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">{t`Prompt`}</Label>
                                <Textarea
                                    className="min-h-[100px] resize-none"
                                    disabled={isStreaming}
                                    onChange={(e) => setNewPrompt(e.target.value)}
                                    placeholder={isImage ? t`Describe the image you want to create...` : t`Describe the video you want to create...`}
                                    value={newPrompt}
                                />
                            </div>

                            {/* Settings based on mode */}
                            {isImage ? (
                                <>
                                    {/* Aspect Ratio */}
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t`Aspect Ratio`}</Label>
                                        <Select
                                            disabled={isStreaming}
                                            onValueChange={(value) => setImageSettings({ aspectRatio: value as ImageSize })}
                                            value={imageSettings.aspectRatio}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {IMAGE_ASPECT_RATIOS.map((ratio) => (
                                                    <SelectItem key={ratio.value} value={ratio.value}>
                                                        <div className="flex items-center gap-2">
                                                            <AspectRatioPreview ratio={ratio.value} />
                                                            <span>{ratio.label}</span>
                                                            <span className="text-muted-foreground text-xs">({i18n._(ratio.description)})</span>
                                                        </div>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Quality */}
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t`Quality`}</Label>
                                        <Select
                                            disabled={isStreaming}
                                            onValueChange={(value) => setImageSettings({ quality: value as "standard" | "hd" })}
                                            value={imageSettings.quality || "standard"}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {QUALITY_OPTIONS.map((option) => (
                                                    <SelectItem key={option.value} value={option.value}>
                                                        {typeof option.label === "string" ? option.label : i18n._(option.label)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Style */}
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t`Style`}</Label>
                                        <Select
                                            disabled={isStreaming}
                                            onValueChange={(value) => setImageSettings({ style: value || undefined })}
                                            value={imageSettings.style || ""}
                                        >
                                            <SelectTrigger>
                                                <SelectValue placeholder={t`Auto`} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {STYLE_OPTIONS.map((option) => (
                                                    <SelectItem key={option.value || "auto"} value={option.value || "auto"}>
                                                        {i18n._(option.label)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Cinema Studio Controls */}
                                    <Collapsible defaultOpen={false}>
                                        <CollapsibleTrigger
                                            render={<Button className="w-full justify-start" disabled={isStreaming} type="button" variant="ghost" />}
                                        >
                                            <VideoIcon className="mr-2 h-4 w-4" />
                                            {t`Professional Camera Controls`}
                                        </CollapsibleTrigger>
                                        <CollapsibleContent className="pt-4">
                                            <CinemaStudioControls
                                                onChange={(cinema) => setImageSettings({ cinema })}
                                                value={imageSettings.cinema || { enabled: false }}
                                            />
                                        </CollapsibleContent>
                                    </Collapsible>
                                </>
                            ) : (
                                <>
                                    {/* Video Aspect Ratio */}
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t`Aspect Ratio`}</Label>
                                        <Select
                                            disabled={isStreaming}
                                            onValueChange={(value) => setVideoSettings({ aspectRatio: value as string })}
                                            value={videoSettings.aspectRatio}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {VIDEO_ASPECT_RATIOS.map((ratio) => (
                                                    <SelectItem key={ratio.value} value={ratio.value}>
                                                        <div className="flex items-center gap-2">
                                                            <AspectRatioPreview ratio={ratio.value} />
                                                            <span>{ratio.label}</span>
                                                            <span className="text-muted-foreground text-xs">({i18n._(ratio.description)})</span>
                                                        </div>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Duration */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <Label className="text-sm font-medium">{t`Duration`}</Label>
                                            <span className="text-muted-foreground text-sm">{formatDuration(videoSettings.duration)}</span>
                                        </div>
                                        <Slider
                                            disabled={isStreaming}
                                            max={60}
                                            min={3}
                                            onValueChange={(values) => {
                                                const v = Array.isArray(values) ? (values[0] ?? 0) : values;

                                                setVideoSettings({ duration: v });
                                            }}
                                            step={1}
                                            value={[videoSettings.duration]}
                                        />
                                        {/* Quick presets */}
                                        <div className="flex flex-wrap gap-1">
                                            {DURATION_MARKS.map((duration) => (
                                                <Button
                                                    className="h-7 px-2 text-xs"
                                                    disabled={isStreaming}
                                                    key={duration}
                                                    onClick={() => setVideoSettings({ duration })}
                                                    size="sm"
                                                    type="button"
                                                    variant={videoSettings.duration === duration ? "default" : "outline"}
                                                >
                                                    {formatDuration(duration)}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Cinema Studio Controls */}
                                    <Collapsible defaultOpen={false}>
                                        <CollapsibleTrigger
                                            render={<Button className="w-full justify-start" disabled={isStreaming} type="button" variant="ghost" />}
                                        >
                                            <VideoIcon className="mr-2 h-4 w-4" />
                                            {t`Professional Camera Controls`}
                                        </CollapsibleTrigger>
                                        <CollapsibleContent className="pt-4">
                                            <CinemaStudioControls
                                                onChange={(cinema) => setVideoSettings({ cinema })}
                                                value={videoSettings.cinema || { enabled: false }}
                                            />
                                        </CollapsibleContent>
                                    </Collapsible>
                                </>
                            )}
                        </div>
                    </MediaPreviewSettingsPanel>
                </MediaPreviewDialogContent>
                <MediaPreviewDialogFooter isSubmitting={isStreaming} onSubmit={handleGenerate} submitLabel={isImage ? t`Generate Image` : t`Generate Video`}>
                    <Button
                        disabled={!selectedItem?.prompt}
                        onClick={() => {
                            if (selectedItem?.prompt) {
                                setNewPrompt(selectedItem.prompt);
                            }
                        }}
                        variant="outline"
                    >
                        <Sparkles className="mr-2 size-4" />
                        {t`Use Original Prompt`}
                    </Button>
                </MediaPreviewDialogFooter>
            </MediaPreviewDialog>
        </div>
    );
};

MediaGalleryView.displayName = "MediaGalleryView";

export default MediaGalleryView;
