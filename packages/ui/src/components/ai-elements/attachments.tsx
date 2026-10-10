"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@ui/components/hover-card";
import cn from "@ui/utils/cn";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import { FileTextIcon, GlobeIcon, ImageIcon, Music2Icon, PaperclipIcon, VideoIcon, XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { useMemo } from "react";

import type { AttachmentContextValue } from "./attachments-context";
import { AttachmentContext, AttachmentsContext } from "./attachments-context";
import { getAttachmentLabel, getMediaCategory, useAttachmentContext, useAttachmentsContext } from "./attachments-utilities";

// ============================================================================
// Types
// ============================================================================

export type AttachmentData = (FileUIPart & { id: string }) | (SourceDocumentUIPart & { id: string });

export type AttachmentMediaCategory = "image" | "video" | "audio" | "document" | "source" | "unknown";

export type AttachmentVariant = "grid" | "inline" | "list";

// ============================================================================
// Attachments - Container
// ============================================================================

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
    variant?: AttachmentVariant;
};

export const Attachments = ({ children, className, variant = "grid", ...props }: AttachmentsProps) => {
    const contextValue = useMemo(() => {
        return { variant };
    }, [variant]);

    return (
        <AttachmentsContext value={contextValue}>
            <div
                className={cn("flex items-start", variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2", variant === "grid" && "ml-auto w-fit", className)}
                {...props}
            >
                {children}
            </div>
        </AttachmentsContext>
    );
};

// ============================================================================
// Attachment - Item
// ============================================================================

export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
    data: AttachmentData;
    onRemove?: () => void;
};

export const Attachment = ({ children, className, data, onRemove, ...props }: AttachmentProps) => {
    const { variant } = useAttachmentsContext();
    const mediaCategory = getMediaCategory(data);

    const contextValue = useMemo<AttachmentContextValue>(() => {
        return { data, mediaCategory, onRemove, variant };
    }, [data, mediaCategory, onRemove, variant]);

    return (
        <AttachmentContext value={contextValue}>
            <div
                className={cn(
                    "group relative",
                    variant === "grid" && "size-24 overflow-hidden rounded-lg",
                    variant === "inline" && [
                        "flex h-8 cursor-pointer items-center gap-1.5 select-none",
                        "border-border rounded-md border px-1.5",
                        "text-sm font-medium transition-all",
                        "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
                    ],
                    variant === "list" && ["flex w-full items-center gap-3 rounded-lg border p-3", "hover:bg-accent/50"],
                    className,
                )}
                {...props}
            >
                {children}
            </div>
        </AttachmentContext>
    );
};

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
    fallbackIcon?: ReactNode;
};

export const AttachmentPreview = ({ className, fallbackIcon, ...props }: AttachmentPreviewProps) => {
    const { t } = useLingui();
    const { data, mediaCategory, variant } = useAttachmentContext();

    const iconSize = variant === "inline" ? "size-3" : "size-4";

    const renderImage = (url: string, filename: string | undefined, isGrid: boolean) =>
        isGrid ? (
            <img alt={filename || t`Image`} className="size-full object-cover" height={96} src={url} width={96} />
        ) : (
            <img alt={filename || t`Image`} className="size-full rounded object-cover" height={20} src={url} width={20} />
        );

    const renderIcon = (Icon: typeof ImageIcon) => <Icon className={cn(iconSize, "text-muted-foreground")} />;

    const renderContent = () => {
        if (mediaCategory === "image" && data.type === "file" && data.url) {
            return renderImage(data.url, data.filename, variant === "grid");
        }

        if (mediaCategory === "video" && data.type === "file" && data.url) {
            return <video aria-label={data.filename || t`Video attachment`} className="size-full object-cover" muted src={data.url} />;
        }

        const iconMap: Record<AttachmentMediaCategory, typeof ImageIcon> = {
            audio: Music2Icon,
            document: FileTextIcon,
            image: ImageIcon,
            source: GlobeIcon,
            unknown: PaperclipIcon,
            video: VideoIcon,
        };

        const Icon = iconMap[mediaCategory];

        return fallbackIcon ?? renderIcon(Icon);
    };

    return (
        <div
            className={cn(
                "flex shrink-0 items-center justify-center overflow-hidden",
                variant === "grid" && "bg-muted size-full",
                variant === "inline" && "bg-background size-5 rounded",
                variant === "list" && "bg-muted size-12 rounded",
                className,
            )}
            {...props}
        >
            {renderContent()}
        </div>
    );
};

// ============================================================================
// AttachmentInfo - Name and type display
// ============================================================================

export type AttachmentInfoProps = HTMLAttributes<HTMLDivElement> & {
    showMediaType?: boolean;
};

export const AttachmentInfo = ({ className, showMediaType = false, ...props }: AttachmentInfoProps) => {
    const { i18n } = useLingui();
    const { data, variant } = useAttachmentContext();

    if (variant === "grid") {
        return null;
    }

    const label = getAttachmentLabel(data, i18n);

    return (
        <div className={cn("min-w-0 flex-1", className)} {...props}>
            <span className="block truncate">{label}</span>
            {showMediaType && data.mediaType && <span className="text-muted-foreground block truncate text-xs">{data.mediaType}</span>}
        </div>
    );
};

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

export type AttachmentRemoveProps = ComponentProps<typeof Button> & {
    label?: string;
};

export const AttachmentRemove = ({ children, className, label: labelProp, ...props }: AttachmentRemoveProps) => {
    const { t } = useLingui();
    const { onRemove, variant } = useAttachmentContext();

    if (!onRemove) {
        return null;
    }

    const label = labelProp ?? t`Remove`;

    return (
        <Button
            aria-label={label}
            className={cn(
                variant === "grid" && [
                    "absolute top-2 right-2 size-6 rounded-full p-0",
                    "bg-background/80 backdrop-blur-sm",
                    "opacity-0 transition-opacity group-hover:opacity-100",
                    "hover:bg-background",
                    "[&>svg]:size-3",
                ],
                variant === "inline" && ["size-5 rounded p-0", "opacity-0 transition-opacity group-hover:opacity-100", "[&>svg]:size-2.5"],
                variant === "list" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
                className,
            )}
            onClick={(e) => {
                e.stopPropagation();
                onRemove();
            }}
            type="button"
            variant="ghost"
            {...props}
        >
            {children ?? <XIcon />}
            <span className="sr-only">{label}</span>
        </Button>
    );
};

// ============================================================================
// AttachmentHoverCard - Hover preview
// ============================================================================

export type AttachmentHoverCardProps = ComponentProps<typeof HoverCard>;

export const AttachmentHoverCard = (props: AttachmentHoverCardProps) => <HoverCard {...props} />;

export type AttachmentHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>;

export const AttachmentHoverCardTrigger = (props: AttachmentHoverCardTriggerProps) => <HoverCardTrigger {...props} />;

export type AttachmentHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const AttachmentHoverCardContent = ({ align = "start", className, ...props }: AttachmentHoverCardContentProps) => (
    <HoverCardContent align={align} className={cn("w-auto p-2", className)} {...props} />
);

// ============================================================================
// AttachmentEmpty - Empty state
// ============================================================================

export type AttachmentEmptyProps = HTMLAttributes<HTMLDivElement>;

export const AttachmentEmpty = ({ children, className, ...props }: AttachmentEmptyProps) => {
    const { t } = useLingui();

    return (
        <div className={cn("text-muted-foreground flex items-center justify-center p-4 text-sm", className)} {...props}>
            {children ?? t`No attachments`}
        </div>
    );
};
