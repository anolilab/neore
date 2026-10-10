/**
 * PresentationSlideCard
 * Ported from kortix-ai/suna PresentationSlideCard.tsx
 *
 * Renders a single slide in a card with an iframe preview.
 * Adapted to use Lunora-stored HTML content instead of sandbox URLs.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Maximize2, Presentation } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createSlideHtml, SLIDE_HEIGHT, SLIDE_WIDTH } from "../lib/slide-html-template";

interface SlideData {
    htmlContent: string;
    slideNumber: number;
    title: string;
}

interface PresentationSlideCardProps {
    className?: string;
    onFullScreenClick?: (slideNumber: number) => void;
    presentationTitle: string;
    showFullScreenButton?: boolean;
    slide: SlideData;
    totalSlides: number;
}

const PresentationSlideCard = ({
    className = "",
    onFullScreenClick,
    presentationTitle,
    showFullScreenButton = true,
    slide,
    totalSlides,
}: PresentationSlideCardProps) => {
    const { t } = useLingui();
    const { slideNumber, title: slideTitle } = slide;
    const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
    const [scale, setScale] = useState(1);

    const slideHtml = useMemo(
        () => createSlideHtml(slide.htmlContent, slide.slideNumber, totalSlides, presentationTitle),
        [slide.htmlContent, slide.slideNumber, totalSlides, presentationTitle],
    );

    useEffect(() => {
        if (!containerRef) {
            return undefined;
        }

        const updateScale = () => {
            const containerWidth = containerRef.offsetWidth;
            const containerHeight = containerRef.offsetHeight;
            const scaleX = containerWidth / SLIDE_WIDTH;
            const scaleY = containerHeight / SLIDE_HEIGHT;
            const newScale = Math.min(scaleX, scaleY);

            if (Math.abs(newScale - scale) > 0.001) {
                setScale(newScale);
            }
        };

        updateScale();

        let resizeTimeout: ReturnType<typeof setTimeout>;
        const debouncedUpdateScale = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(updateScale, 50);
        };

        const resizeObserver = new ResizeObserver(debouncedUpdateScale);

        resizeObserver.observe(containerRef);
        window.addEventListener("resize", debouncedUpdateScale);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener("resize", debouncedUpdateScale);
            clearTimeout(resizeTimeout);
        };
    }, [containerRef, scale]);

    if (!slide.htmlContent) {
        return (
            <div className={`group bg-background relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 ${className}`}>
                <div className="border-border/40 bg-muted/20 flex items-center justify-between border-b px-3 py-2">
                    <div className="flex items-center gap-2">
                        <Badge className="h-6 px-2 font-mono text-xs" variant="outline">
                            #{slide.slideNumber}
                        </Badge>
                        {slide.title && <span className="text-muted-foreground truncate text-sm">{slide.title}</span>}
                    </div>
                </div>
                <div className="bg-muted/30 flex h-48 items-center justify-center">
                    <div className="text-center">
                        <Presentation className="mx-auto mb-4 h-12 w-12 text-zinc-400" />
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">
                            <Trans>No slide content to preview</Trans>
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className={`group bg-background relative overflow-hidden rounded-xl border border-zinc-200 transition-all duration-200 hover:scale-[1.01] hover:shadow-lg hover:shadow-black/5 dark:border-zinc-800 dark:hover:shadow-black/20 ${className}`}
        >
            {/* Slide header */}
            <div className="border-border/40 bg-muted/20 flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-2">
                    <Badge className="h-6 px-2 font-mono text-xs" variant="outline">
                        #{slide.slideNumber}
                    </Badge>
                    {slide.title && <span className="text-muted-foreground truncate text-sm">{slide.title}</span>}
                </div>
                {showFullScreenButton && (
                    <Button
                        className="h-8 w-8 p-0 opacity-60 transition-opacity group-hover:opacity-100"
                        disabled={!onFullScreenClick}
                        onClick={() => onFullScreenClick?.(slide.slideNumber)}
                        size="sm"
                        title={t`Open in full screen`}
                        variant="ghost"
                    >
                        <Maximize2 className="h-4 w-4" />
                    </Button>
                )}
            </div>

            {/* Slide Preview */}
            <div
                aria-label={t`Open slide ${slideNumber} in full screen`}
                className="bg-muted/30 relative aspect-video cursor-pointer"
                onClick={() => onFullScreenClick?.(slide.slideNumber)}
                onKeyDown={(e) => {
                    if (!(e.key === "Enter" || e.key === " ")) {
                        return;
                    }

                    e.preventDefault();
                    onFullScreenClick?.(slide.slideNumber);
                }}
                role="button"
                tabIndex={0}
            >
                <div className="flex h-full w-full items-center justify-center bg-transparent">
                    <div
                        className="bg-background relative h-full w-full overflow-hidden rounded-lg"
                        ref={setContainerRef}
                        style={{
                            contain: "layout style",
                            containIntrinsicSize: `${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px`,
                        }}
                    >
                        <iframe
                            className="rounded-xl border-0"
                            key={`slide-${slide.slideNumber}`}
                            sandbox="allow-scripts"
                            srcDoc={slideHtml}
                            style={{
                                backfaceVisibility: "hidden",
                                border: "none",
                                display: "block",
                                height: `${SLIDE_HEIGHT}px`,
                                left: 0,
                                position: "absolute",
                                top: 0,
                                transform: `scale(${scale})`,
                                transformOrigin: "0 0",
                                WebkitBackfaceVisibility: "hidden",
                                width: `${SLIDE_WIDTH}px`,
                                willChange: "transform",
                            }}
                            title={t`Slide ${slideNumber}: ${slideTitle}`}
                        />
                    </div>
                </div>

                {/* Subtle hover overlay */}
                <div className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/5" />
            </div>
        </div>
    );
};

export default PresentationSlideCard;
