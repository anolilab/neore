import * as React from "react";

const badgeWidthCache = new Map<string, number>();

const DEFAULT_CONTAINER_PADDING = 16; // px-2 = 8px * 2
const DEFAULT_BADGE_GAP = 4; // gap-1 = 4px
const DEFAULT_OVERFLOW_BADGE_WIDTH = 40; // Approximate width of "+N" badge

interface MeasureBadgeWidthProps {
    cacheKey: string;
    className?: string;
    iconSize?: number;
    label: string;
    maxWidth?: number;
}

const measureBadgeWidth = ({ cacheKey, className, iconSize, label, maxWidth }: MeasureBadgeWidthProps): number => {
    const cached = badgeWidthCache.get(cacheKey);

    if (cached !== undefined) {
        return cached;
    }

    const measureElement = document.createElement("div");

    measureElement.className = `inline-flex items-center rounded-md border px-1.5 text-xs font-semibold h-5 gap-1 shrink-0 absolute invisible pointer-events-none ${
        className ?? ""
    }`;
    measureElement.style.whiteSpace = "nowrap";

    if (iconSize) {
        const icon = document.createElement("span");

        icon.className = "shrink-0";
        icon.style.width = `${iconSize}px`;
        icon.style.height = `${iconSize}px`;
        measureElement.appendChild(icon);
    }

    if (maxWidth) {
        const text = document.createElement("span");

        text.className = "truncate";
        text.style.maxWidth = `${maxWidth}px`;
        text.textContent = label;
        measureElement.appendChild(text);
    } else {
        measureElement.textContent = label;
    }

    document.body.appendChild(measureElement);
    const width = measureElement.offsetWidth;

    measureElement.remove();

    badgeWidthCache.set(cacheKey, width);

    return width;
};

interface UseBadgeOverflowProps<T> {
    badgeGap?: number;
    cacheKeyPrefix?: string;
    className?: string;
    containerPadding?: number;
    containerRef: React.RefObject<HTMLElement | null>;
    getLabel: (item: T) => string;
    iconSize?: number;
    items: T[];
    lineCount: number;
    maxWidth?: number;
    overflowBadgeWidth?: number;
}

interface UseBadgeOverflowReturn<T> {
    containerWidth: number;
    hiddenCount: number;
    visibleItems: T[];
}

export const useBadgeOverflow = <T>({
    badgeGap = DEFAULT_BADGE_GAP,
    cacheKeyPrefix = "",
    className,
    containerPadding = DEFAULT_CONTAINER_PADDING,
    containerRef,
    getLabel,
    iconSize,
    items,
    lineCount,
    maxWidth,
    overflowBadgeWidth = DEFAULT_OVERFLOW_BADGE_WIDTH,
}: UseBadgeOverflowProps<T>): UseBadgeOverflowReturn<T> => {
    const [containerWidth, setContainerWidth] = React.useState(0);

    React.useEffect(() => {
        if (!containerRef.current) {
            return undefined;
        }

        const measureWidth = () => {
            if (!containerRef.current) {
                return;
            }

            const width = containerRef.current.clientWidth - containerPadding;

            setContainerWidth(width);
        };

        measureWidth();

        const resizeObserver = new ResizeObserver(measureWidth);

        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
        };
    }, [containerRef, containerPadding]);

    const result = React.useMemo(() => {
        if (!containerWidth || items.length === 0) {
            return { containerWidth, hiddenCount: 0, visibleItems: items };
        }

        let currentLineWidth = 0;
        let currentLine = 1;
        const visible: T[] = [];

        for (const item of items) {
            const label = getLabel(item);
            const cacheKey = cacheKeyPrefix ? `${cacheKeyPrefix}:${label}` : label;
            const badgeWidth = measureBadgeWidth({
                cacheKey,
                className,
                iconSize,
                label,
                maxWidth,
            });
            const widthWithGap = badgeWidth + badgeGap;

            if (currentLineWidth + widthWithGap <= containerWidth) {
                currentLineWidth += widthWithGap;
                visible.push(item);
            } else if (currentLine < lineCount) {
                currentLine++;
                currentLineWidth = widthWithGap;
                visible.push(item);
            } else {
                if (currentLineWidth + overflowBadgeWidth > containerWidth && visible.length > 0) {
                    visible.pop();
                }

                break;
            }
        }

        return {
            containerWidth,
            hiddenCount: Math.max(0, items.length - visible.length),
            visibleItems: visible,
        };
    }, [items, getLabel, containerWidth, lineCount, cacheKeyPrefix, iconSize, maxWidth, className, badgeGap, overflowBadgeWidth]);

    return result;
};

export const clearBadgeWidthCache = (): void => {
    badgeWidthCache.clear();
};
