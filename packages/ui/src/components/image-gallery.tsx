"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import { Textarea } from "@ui/components/textarea";
import cn from "@ui/utils/cn";
import { AlertCircle, Check, ImageIcon, Play } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useMemo, useState } from "react";

import { ImageGalleryContext } from "./image-gallery-context";
import LazyImage from "./lazy-image";
import { useImageGallery } from "./use-image-gallery";

// Types
export interface GalleryItem {
    alt?: string;
    aspectRatio?: string;
    batchId?: string; // groups images from the same generation request
    createdAt?: Date;
    duration?: number; // for videos, in seconds
    id: string;
    modelName?: string; // display name of the model used for generation
    nsfwStatus?: string; // NSFW classification status
    prompt?: string;
    src: string;
    thumbnail?: string;
    type: "image" | "video";
}

// Root component
interface ImageGalleryProps {
    children?: React.ReactNode;
    className?: string;
    items: GalleryItem[];
    /** Maximum number of items that can be selected (default: 4) */
    maxSelections?: number;
    onItemClick?: (item: GalleryItem) => void;
    /** @deprecated Use onSelectionChange instead */
    onSelect?: (id: string | null) => void;
    /** Callback when selection changes (for multi-selection) */
    onSelectionChange?: (ids: string[]) => void;
    /** @deprecated Use selectedIds instead */
    selectedId?: string | null;
    /** Array of selected item IDs for multi-selection */
    selectedIds?: string[];
    /** Whether selection is enabled (default: true) */
    selectionEnabled?: boolean;
}

const ImageGallery = ({
    children,
    className,
    items,
    maxSelections = 4,
    onItemClick,
    onSelect: controlledOnSelect,
    onSelectionChange,
    selectedId: controlledSelectedId,
    selectedIds: controlledSelectedIds,
    selectionEnabled = true,
    ...props
}: ImageGalleryProps) => {
    const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([]);

    // Support both old single-selection API and new multi-selection API
    const uncontrolledSelectedIds = controlledSelectedId === undefined || controlledSelectedId === null ? internalSelectedIds : [controlledSelectedId];
    const selectedIds = controlledSelectedIds === undefined ? uncontrolledSelectedIds : controlledSelectedIds;

    const handleSelectionChange = useCallback(
        (ids: string[]) => {
            if (onSelectionChange) {
                onSelectionChange(ids);
            } else if (controlledOnSelect) {
                // Backward compatibility: call old API with first selected item
                controlledOnSelect(ids.length > 0 ? (ids[0] ?? null) : null);
            } else {
                setInternalSelectedIds(ids);
            }
        },
        [onSelectionChange, controlledOnSelect],
    );

    const handleToggleSelection = useCallback(
        (item: GalleryItem) => {
            const isSelected = selectedIds.includes(item.id);

            if (isSelected) {
                // Remove from selection
                handleSelectionChange(selectedIds.filter((id) => id !== item.id));
            } else if (selectedIds.length < maxSelections) {
                // Add to selection (if under max)
                handleSelectionChange([...selectedIds, item.id]);
            }
            // If at max selections and item not selected, do nothing (can't add more)
        },
        [selectedIds, maxSelections, handleSelectionChange],
    );

    const handleItemClick = useCallback(
        (item: GalleryItem) => {
            onItemClick?.(item);
        },
        [onItemClick],
    );

    const contextValue = useMemo(() => {
        return {
            items,
            maxSelections,
            onItemClick: handleItemClick,
            onSelect: handleSelectionChange,
            onToggleSelection: handleToggleSelection,
            selectedIds,
            selectionEnabled,
        };
    }, [items, maxSelections, handleItemClick, handleSelectionChange, handleToggleSelection, selectedIds, selectionEnabled]);

    return (
        <ImageGalleryContext value={contextValue}>
            <div className={cn("relative", className)} data-slot="image-gallery" {...props}>
                {children}
            </div>
        </ImageGalleryContext>
    );
};

// Grid component
interface ImageGalleryGridProps {
    className?: string;
}

const ImageGalleryGrid = ({ className }: ImageGalleryGridProps) => {
    const { items } = useImageGallery();

    return (
        <div
            className={cn(
                "grid w-full gap-1",
                // Responsive columns: 2 on mobile, 3 on sm, 4 on md+
                "grid-cols-2 sm:grid-cols-3 md:grid-cols-4",
                className,
            )}
            data-slot="image-gallery-grid"
        >
            {items.map((item) => (
                <ImageGalleryItem item={item} key={item.id} />
            ))}
        </div>
    );
};

// Individual item component
interface ImageGalleryItemProps {
    className?: string;
    item: GalleryItem;
}

const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${mins}:${String(secs).padStart(2, "0")}`;
};

const ImageGalleryItem = ({ className, item }: ImageGalleryItemProps) => {
    const { t } = useLingui();
    const { maxSelections, onItemClick, onToggleSelection, selectedIds, selectionEnabled } = useImageGallery();
    const isSelected = selectedIds.includes(item.id);
    const isAtMaxSelections = selectedIds.length >= maxSelections;
    const canSelect = isSelected || !isAtMaxSelections;

    const thumbnailSource = item.thumbnail || item.src;

    const handleClick = () => {
        onItemClick(item);
    };

    const handleCheckboxClick = (e: MouseEvent) => {
        e.stopPropagation(); // Prevent opening the preview dialog

        if (selectionEnabled && canSelect) {
            onToggleSelection(item);
        }
    };

    return (
        <button
            className={cn(
                "group relative overflow-hidden rounded-lg",
                "border-1 transition-all duration-200",
                "hover:ring-primary/50 hover:ring-2 hover:ring-offset-2",
                "focus-visible:ring-primary focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                isSelected ? "border-primary ring-primary ring-2 ring-offset-2" : "border-transparent",
                className,
            )}
            data-selected={isSelected}
            data-slot="image-gallery-item"
            onClick={handleClick}
            type="button"
        >
            {/* Image/Video thumbnail with lazy loading */}
            {item.nsfwStatus === "blocked" || item.nsfwStatus === "checking" ? (
                <div className="bg-muted flex aspect-square items-center justify-center">
                    <div className="flex flex-col items-center gap-1.5">
                        <AlertCircle className="size-6 text-amber-500" />
                        <span className="text-muted-foreground text-[10px]">{item.nsfwStatus === "checking" ? "Scanning..." : "Flagged"}</span>
                    </div>
                </div>
            ) : (
                <LazyImage
                    alt={item.alt || t`Gallery item`}
                    aspectRatioClassName="border-0 bg-muted"
                    className="transition-transform duration-300 group-hover:scale-105"
                    fallback={undefined}
                    inView
                    ratio={1}
                    src={thumbnailSource}
                />
            )}

            {/* Overlay for videos */}
            {item.type === "video" && (
                <>
                    {/* Play icon */}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                        <div className="flex size-12 items-center justify-center rounded-full bg-white/90">
                            <Play className="ml-1 size-6 fill-black text-black" />
                        </div>
                    </div>

                    {/* Duration badge */}
                    {item.duration && (
                        <div className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                            {formatDuration(item.duration)}
                        </div>
                    )}
                </>
            )}

            {/* Selection checkbox - always visible when selection is enabled */}
            {selectionEnabled && (
                <div
                    aria-checked={isSelected}
                    aria-label={isSelected ? t`Deselect image` : t`Select image as reference`}
                    className={cn(
                        "absolute top-2 right-2 flex size-6 items-center justify-center rounded-full",
                        "cursor-pointer transition-all duration-200",
                        "focus-visible:ring-primary focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                        isSelected ? "bg-primary" : "border-2 border-white/70 bg-black/40 hover:bg-black/60",
                        !canSelect && !isSelected && "cursor-not-allowed opacity-50",
                    )}
                    onClick={handleCheckboxClick}
                    onKeyDown={(e) => {
                        if (!(e.key === "Enter" || e.key === " ")) {
                            return;
                        }

                        e.preventDefault();
                        e.stopPropagation();

                        if (canSelect) {
                            onToggleSelection(item);
                        }
                    }}
                    role="checkbox"
                    tabIndex={0}
                >
                    {isSelected && <Check className="text-primary-foreground size-4" />}
                </div>
            )}

            {/* Aspect ratio indicator */}
            {item.aspectRatio && (
                <div className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                    {item.aspectRatio}
                </div>
            )}
        </button>
    );
};

// ─── Krea-style components ────────────────────────────────────────────────────

/**
 * Full-bleed image cell used inside the Krea batch layout.
 * Aspect ratio is detected from the image's natural dimensions after load,
 * so portrait/landscape/square images render at their true proportions.
 */
const KreaImageItem = ({ className, item }: ImageGalleryItemProps) => {
    const { t } = useLingui();
    const { maxSelections, onItemClick, onToggleSelection, selectedIds, selectionEnabled } = useImageGallery();
    const isSelected = selectedIds.includes(item.id);
    const isAtMaxSelections = selectedIds.length >= maxSelections;
    const canSelect = isSelected || !isAtMaxSelections;
    // Default to 4/3 until the image loads and we know its real dimensions
    const [cellAspectRatio, setCellAspectRatio] = useState<string>("4/3");

    return (
        <button
            className={cn(
                "group relative overflow-hidden bg-zinc-900 dark:bg-[#111111]",
                "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none focus-visible:ring-inset",
                isSelected && "ring-2 ring-white ring-inset",
                className,
            )}
            data-selected={isSelected}
            data-slot="krea-gallery-item"
            onClick={() => onItemClick(item)}
            style={{ aspectRatio: cellAspectRatio }}
            type="button"
        >
            {item.nsfwStatus === "blocked" || item.nsfwStatus === "checking" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-zinc-800">
                    <div className="flex flex-col items-center gap-1.5">
                        <AlertCircle className="size-6 text-amber-500" />
                        <span className="text-xs text-zinc-400">{item.nsfwStatus === "checking" ? "Scanning..." : "Flagged for review"}</span>
                    </div>
                </div>
            ) : (
                <img
                    alt={item.alt || ""}
                    className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    loading="lazy"
                    onLoad={(e) => {
                        const img = e.currentTarget;

                        if (img.naturalWidth && img.naturalHeight) {
                            setCellAspectRatio(`${img.naturalWidth}/${img.naturalHeight}`);
                        }
                    }}
                    src={item.thumbnail || item.src}
                />
            )}

            {/* Dark scrim on hover */}
            <div className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/15" />

            {/* Video play button */}
            {item.type === "video" && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex size-11 items-center justify-center rounded-full border border-white/20 bg-black/50 opacity-70 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                        <Play className="ml-0.5 size-5 fill-white text-white" />
                    </div>
                    {item.duration && (
                        <div className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                            {formatDuration(item.duration)}
                        </div>
                    )}
                </div>
            )}

            {/* Selection circle */}
            {selectionEnabled && (
                <div
                    aria-checked={isSelected}
                    aria-label={isSelected ? t`Deselect` : t`Select as reference`}
                    className={cn(
                        "absolute top-2.5 right-2.5 flex size-5 items-center justify-center rounded-full",
                        "cursor-pointer transition-all duration-200",
                        "focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none",
                        isSelected ? "bg-white opacity-100" : "border border-white/40 bg-black/50 opacity-0 group-hover:opacity-100",
                        !canSelect && !isSelected && "cursor-not-allowed",
                    )}
                    onClick={(e: MouseEvent) => {
                        e.stopPropagation();

                        if (canSelect) {
                            onToggleSelection(item);
                        }
                    }}
                    onKeyDown={(e) => {
                        if (!(e.key === "Enter" || e.key === " ")) {
                            return;
                        }

                        e.preventDefault();
                        e.stopPropagation();

                        if (canSelect) {
                            onToggleSelection(item);
                        }
                    }}
                    role="checkbox"
                    tabIndex={0}
                >
                    {isSelected && <Check className="size-3 text-black" />}
                </div>
            )}
        </button>
    );
};

const formatRelativeDate = (date: Date, locale: string): string => {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });

    if (diffMins < 60) return format.format(-diffMins, "minute");

    const diffHours = Math.floor(diffMins / 60);

    if (diffHours < 24) return format.format(-diffHours, "hour");

    return format.format(-Math.floor(diffHours / 24), "day");
};

/**
 * One "batch" row in the Krea layout:
 *   [Prompt card (fixed 240 px)] | [2-column image grid].
 */
const GalleryBatchRow = ({ items }: { items: GalleryItem[] }) => {
    const { i18n, t } = useLingui();
    const firstItem = items[0];
    const prompt = firstItem?.prompt;
    const modelName = firstItem?.modelName;
    const createdAt = firstItem?.createdAt;

    return (
        <div className="grid gap-1" style={{ gridTemplateColumns: "240px 1fr" }}>
            {/* ── Prompt card ── */}
            <div className="flex flex-col overflow-hidden rounded-lg border border-black/[0.08] bg-zinc-100 dark:border-white/[0.05] dark:bg-[#161616]">
                {/* Model name header */}
                {modelName && (
                    <div className="flex items-center gap-2 border-b border-black/[0.06] px-3.5 py-2.5 dark:border-white/[0.04]">
                        <span className="truncate text-[11px] font-medium tracking-wide text-zinc-500 dark:text-white/50">{modelName}</span>
                    </div>
                )}

                {/* Prompt — Textarea handles max-height + expand dialog */}
                <div className="flex-1 p-1">
                    <Textarea expandable expandableDialogTitle={t`Prompt`} placeholder={t`No prompt`} readOnly size="sm" value={prompt ?? ""} />
                </div>

                {/* Footer: time + image count */}
                <div className="flex items-center justify-between border-t border-black/[0.06] px-3.5 py-2 dark:border-white/[0.04]">
                    <span className="text-[11px] text-zinc-400 dark:text-white/25">{createdAt ? formatRelativeDate(createdAt, i18n.locale) : ""}</span>
                    <span className="text-[11px] text-zinc-400 dark:text-white/25">
                        <Plural one="# image" other="# images" value={items.length} />
                    </span>
                </div>
            </div>

            {/* ── Images grid ── */}
            <div className="grid grid-cols-2 gap-1">
                {items.map((item, i) => (
                    <KreaImageItem
                        className={cn(
                            // 3-image batch: third image spans full width
                            items.length === 3 && i === 2 && "col-span-2",
                        )}
                        item={item}
                        key={item.id}
                    />
                ))}
            </div>
        </div>
    );
};

/**
 * Krea AI-style gallery grid.
 *
 * Groups items by `batchId` (items from the same generation request).
 * Each group renders as: [Prompt card] | [2×2 image grid].
 */
const ImageGalleryKreaGrid = ({ className }: { className?: string }) => {
    const { items } = useImageGallery();

    const batches = useMemo(() => {
        const map = new Map<string, GalleryItem[]>();
        const ungrouped: GalleryItem[] = [];

        for (const item of items) {
            if (item.batchId) {
                const batch = map.get(item.batchId) ?? [];

                batch.push(item);
                map.set(item.batchId, batch);
            } else {
                ungrouped.push(item);
            }
        }

        const result: GalleryItem[][] = [...map.values()];

        // Ungrouped items each get their own single-item batch
        for (const item of ungrouped) {
            result.push([item]);
        }

        return result;
    }, [items]);

    return (
        <div className={cn("space-y-1", className)}>
            {batches.map((batch) => (
                <GalleryBatchRow items={batch} key={batch[0]?.batchId ?? batch[0]?.id} />
            ))}
        </div>
    );
};

// ─── Empty state component ─────────────────────────────────────────────────────

// Empty state component
interface ImageGalleryEmptyProps {
    children?: React.ReactNode;
    className?: string;
    description?: string;
    icon?: React.ReactNode;
    title?: string;
}

const ImageGalleryEmpty = ({ children, className, description, icon, title }: ImageGalleryEmptyProps) => {
    const { t } = useLingui();

    return (
        <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)} data-slot="image-gallery-empty">
            {icon || <ImageIcon className="text-muted-foreground mb-4 size-12" />}
            <h3 className="text-foreground mb-1 text-lg font-medium">{title ?? t`No items`}</h3>
            <p className="text-muted-foreground text-sm">{description ?? t`There are no items to display.`}</p>
            {children}
        </div>
    );
};

export { ImageGallery, ImageGalleryEmpty, ImageGalleryGrid, ImageGalleryItem, ImageGalleryKreaGrid };
