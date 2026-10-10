/**
 * PresentationSlideSkeleton
 * Ported from kortix-ai/suna PresentationSlideSkeleton.tsx
 *
 * Empty slide placeholder that can show real-time streaming content.
 * No loading states - just empty frames that fill in with actual HTML.
 */

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import cn from "@neore/ui/utils/cn";
import { useEffect, useState } from "react";

import { createStreamingSlideHtml, SLIDE_HEIGHT, SLIDE_WIDTH } from "../lib/slide-html-template";

interface PresentationSlideSkeletonProps {
    className?: string;
    isGenerating?: boolean;
    slideNumber: number;
    slideTitle?: string;
    /** Streaming HTML content to render live as it's being generated */
    streamingContent?: string;
}

const PresentationSlideSkeleton = ({ className = "", isGenerating = false, slideNumber, slideTitle, streamingContent }: PresentationSlideSkeletonProps) => {
    const { t } = useLingui();
    const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
    const [scale, setScale] = useState(1);

    useEffect(() => {
        if (!containerRef) {
            return undefined;
        }

        const updateScale = () => {
            const containerWidth = containerRef.offsetWidth;
            const containerHeight = containerRef.offsetHeight;
            const scaleX = containerWidth / SLIDE_WIDTH;
            const scaleY = containerHeight / SLIDE_HEIGHT;

            setScale(Math.min(scaleX, scaleY));
        };

        updateScale();
        const resizeObserver = new ResizeObserver(updateScale);

        resizeObserver.observe(containerRef);

        return () => resizeObserver.disconnect();
    }, [containerRef]);

    const streamingHtmlDocument = streamingContent ? createStreamingSlideHtml(streamingContent) : null;

    const hasContent = !!streamingContent && streamingContent.trim().length > 0;

    return (
        <div
            className={cn(
                "group bg-background relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800",
                isGenerating && "ring-2 ring-blue-500/30",
                className,
            )}
        >
            {/* Slide header */}
            <div className="border-border/40 bg-muted/20 flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-2">
                    <Badge
                        className={cn("h-6 px-2 font-mono text-xs", isGenerating && "border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20")}
                        variant="outline"
                    >
                        #{slideNumber}
                    </Badge>
                    {slideTitle ? (
                        <span className="text-muted-foreground truncate text-sm">{slideTitle}</span>
                    ) : (
                        <span className="text-muted-foreground/40 text-sm">&mdash;</span>
                    )}
                </div>
                {isGenerating && (
                    <div className="flex items-center gap-1.5">
                        <div className="h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-blue-500" />
                    </div>
                )}
            </div>

            {/* Slide Preview */}
            <div className="relative aspect-video">
                <div
                    className={cn(
                        "relative h-full w-full overflow-hidden",
                        !hasContent && "bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900",
                    )}
                    ref={setContainerRef}
                >
                    {hasContent && streamingHtmlDocument ? (
                        <iframe
                            className="border-0"
                            sandbox="allow-same-origin"
                            srcDoc={streamingHtmlDocument}
                            style={{
                                border: "none",
                                display: "block",
                                height: `${SLIDE_HEIGHT}px`,
                                left: 0,
                                position: "absolute",
                                top: 0,
                                transform: `scale(${scale})`,
                                transformOrigin: "0 0",
                                width: `${SLIDE_WIDTH}px`,
                            }}
                            title={t`Slide ${slideNumber} (generating)`}
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="text-center opacity-20">
                                <span className="text-6xl font-bold text-zinc-400 dark:text-zinc-600">{slideNumber}</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PresentationSlideSkeleton;
