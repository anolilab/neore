"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Dialog, DialogClose, DialogPopup } from "@ui/components/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@ui/components/resizable";
import { ScrollArea } from "@ui/components/scroll-area";
import cn from "@ui/utils/cn";
import { Download, ImageIcon, Pause, Play, VideoIcon } from "lucide-react";
import * as React from "react";
import { useCallback, useMemo, useState } from "react";

import { MediaPreviewDialogContext } from "./media-preview-dialog-context";
import { useMediaPreviewDialog } from "./use-media-preview-dialog";

// Types
export interface MediaItem {
    alt?: string;
    aspectRatio?: string;
    createdAt?: Date;
    duration?: number;
    id: string;
    prompt?: string;
    src: string;
    thumbnail?: string;
    type: "image" | "video";
}

// Root component
interface MediaPreviewDialogProps {
    children?: React.ReactNode;
    media: MediaItem | null;
    onOpenChange: (open: boolean) => void;
    open: boolean;
}

const MediaPreviewDialog = ({ children, media, onOpenChange, open }: MediaPreviewDialogProps) => {
    const [isPlaying, setIsPlaying] = useState(false);
    const [wasOpen, setWasOpen] = useState(open);

    // Reset playing state when dialog closes. Adjusting during render rather
    // than in an effect avoids the extra commit a cascading setState causes.
    if (wasOpen !== open) {
        setWasOpen(open);

        if (!open) {
            setIsPlaying(false);
        }
    }

    const contextValue = useMemo(() => {
        return { isPlaying, media, setIsPlaying };
    }, [isPlaying, media]);

    return (
        <MediaPreviewDialogContext value={contextValue}>
            <Dialog onOpenChange={onOpenChange} open={open}>
                <DialogPopup bottomStickOnMobile={false} className="max-h-[90vh] w-[95vw] max-w-5xl overflow-hidden p-0" showCloseButton>
                    {children}
                </DialogPopup>
            </Dialog>
        </MediaPreviewDialogContext>
    );
};

// Content wrapper with split layout
interface MediaPreviewDialogContentProps {
    children?: React.ReactNode;
    className?: string;
}

const MediaPreviewDialogContent = ({ children, className }: MediaPreviewDialogContentProps) => (
    <div className={cn("flex h-[80vh]", className)} data-slot="media-preview-dialog-content">
        <ResizablePanelGroup orientation="horizontal">{children}</ResizablePanelGroup>
    </div>
);

// Preview panel (left side)
interface MediaPreviewPanelProps {
    children?: React.ReactNode;
    className?: string;
    defaultSize?: number;
    minSize?: number;
}

const MediaPreviewPanel = ({ children, className, defaultSize = 60, minSize = 30 }: MediaPreviewPanelProps) => {
    const { t } = useLingui();
    const { isPlaying, media, setIsPlaying } = useMediaPreviewDialog();
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const [imageError, setImageError] = useState(false);

    const handlePlayPause = useCallback(() => {
        if (!videoRef.current) {
            return;
        }

        if (isPlaying) {
            videoRef.current.pause();
        } else {
            videoRef.current.play();
        }

        setIsPlaying(!isPlaying);
    }, [isPlaying, setIsPlaying]);

    const handleDownload = useCallback(() => {
        if (!media?.src) {
            return;
        }

        const link = document.createElement("a");

        link.href = media.src;
        link.download = `${media.type}-${media.id}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }, [media]);

    if (!media) {
        return (
            <ResizablePanel defaultSize={defaultSize} minSize={minSize}>
                <div className={cn("bg-muted flex h-full items-center justify-center", className)}>
                    <ImageIcon className="text-muted-foreground size-16" />
                </div>
            </ResizablePanel>
        );
    }

    const imageContent = imageError ? (
        <div className="flex flex-col items-center text-white/50">
            <ImageIcon className="mb-2 size-16" />
            <span>{t`Failed to load image`}</span>
        </div>
    ) : (
        <img alt={media.alt || t`Preview`} className="max-h-full max-w-full object-contain" onError={() => setImageError(true)} src={media.src} />
    );

    return (
        <ResizablePanel defaultSize={defaultSize} minSize={minSize}>
            <div className={cn("relative flex h-full flex-col bg-black/95", className)}>
                {/* Media display */}
                <div className="relative flex flex-1 items-center justify-center p-4">
                    {media.type === "image" ? (
                        imageContent
                    ) : (
                        <video
                            className="max-h-full max-w-full object-contain"
                            controls={false}
                            onEnded={() => setIsPlaying(false)}
                            onPause={() => setIsPlaying(false)}
                            onPlay={() => setIsPlaying(true)}
                            ref={videoRef}
                            src={media.src}
                        />
                    )}
                </div>

                {/* Controls */}
                <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {media.type === "video" && (
                                <Button
                                    aria-label={isPlaying ? t`Pause` : t`Play`}
                                    className="text-white hover:bg-white/20"
                                    onClick={handlePlayPause}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    {isPlaying ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
                                </Button>
                            )}
                            <span className="flex items-center gap-1.5 text-sm text-white/70">
                                {media.type === "image" ? <ImageIcon className="size-4" /> : <VideoIcon className="size-4" />}
                                {media.aspectRatio}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button aria-label={t`Download`} className="text-white hover:bg-white/20" onClick={handleDownload} size="icon-sm" variant="ghost">
                                <Download aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                    </div>
                </div>

                {children}
            </div>
        </ResizablePanel>
    );
};

// Settings panel (right side)
interface MediaPreviewSettingsPanelProps {
    children?: React.ReactNode;
    className?: string;
    defaultSize?: number;
    description?: string;
    minSize?: number;
    title?: string;
}

const MediaPreviewSettingsPanel = ({ children, className, defaultSize = 40, description, minSize = 25, title }: MediaPreviewSettingsPanelProps) => {
    const { t } = useLingui();
    const { media } = useMediaPreviewDialog();

    return (
        <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={defaultSize} minSize={minSize}>
                <div className={cn("bg-background flex h-full flex-col", className)}>
                    {/* Header */}
                    {(title || description) && (
                        <div className="border-b p-4">
                            {title && <h3 className="font-heading text-lg font-semibold">{title}</h3>}
                            {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
                        </div>
                    )}

                    {/* Settings content */}
                    <ScrollArea className="flex-1">
                        <div className="p-4">{children}</div>
                    </ScrollArea>

                    {/* Prompt display if available */}
                    {media?.prompt && (
                        <div className="border-t p-4">
                            <h4 className="text-muted-foreground mb-2 text-xs font-medium uppercase">{t`Original Prompt`}</h4>
                            <p className="text-foreground text-sm">{media.prompt}</p>
                        </div>
                    )}
                </div>
            </ResizablePanel>
        </>
    );
};

// Footer for action buttons
interface MediaPreviewDialogFooterProps {
    cancelLabel?: string;
    children?: React.ReactNode;
    className?: string;
    isSubmitting?: boolean;
    onSubmit?: () => void;
    submitLabel?: string;
}

const MediaPreviewDialogFooter = ({ cancelLabel, children, className, isSubmitting, onSubmit, submitLabel }: MediaPreviewDialogFooterProps) => {
    const { t } = useLingui();

    return (
        <div className={cn("bg-muted/50 flex items-center justify-end gap-2 border-t px-4 py-3", className)} data-slot="media-preview-dialog-footer">
            {children}
            <DialogClose render={<Button variant="outline">{cancelLabel ?? t`Cancel`}</Button>} />
            {onSubmit && (
                <Button disabled={isSubmitting} onClick={onSubmit}>
                    {isSubmitting ? t`Generating...` : (submitLabel ?? t`Generate`)}
                </Button>
            )}
        </div>
    );
};

export { MediaPreviewDialog, MediaPreviewDialogContent, MediaPreviewDialogFooter, MediaPreviewPanel, MediaPreviewSettingsPanel };
