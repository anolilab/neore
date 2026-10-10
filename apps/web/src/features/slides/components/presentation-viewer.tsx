/**
 * PresentationViewer
 * Ported from kortix-ai/suna PresentationViewer.tsx
 *
 * Main presentation viewer component that shows slides in a scrollable list
 * with a card header and optional full-screen mode.
 *
 * Adapted to load data from Lunora instead of sandbox filesystem.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { AlertTriangle, Download, ExternalLink, FileText, Presentation } from "lucide-react";
import { useEffect, useState } from "react";

import usePresentationViewerStore from "../hooks/use-presentation-viewer-store";
import type { DownloadFormat } from "../types";
import FullScreenPresentationViewer from "./full-screen-presentation-viewer";
import PresentationSlideCard from "./presentation-slide-card";
import PresentationSlideSkeleton from "./presentation-slide-skeleton";

interface SlideData {
    _id: string;
    htmlContent: string;
    slideNumber: number;
    title: string;
}

interface PresentationViewerProps {
    /** Slide to highlight as "current" */
    currentSlideNumber?: number;
    error?: string | null;
    isLoading?: boolean;
    isStreaming?: boolean;
    onDownload?: (format: DownloadFormat) => Promise<void>;
    presentationId: string;
    presentationTitle: string;
    showHeader?: boolean;
    slides: SlideData[];
    streamingContent?: string;
    /** Currently generating slide number (for streaming skeleton) */
    streamingSlideNumber?: number;
    streamingSlideTitle?: string;
}

const PresentationViewer = ({
    currentSlideNumber,
    error = null,
    isLoading = false,
    isStreaming = false,
    onDownload,
    presentationId,
    presentationTitle,
    showHeader = true,
    slides,
    streamingContent,
    streamingSlideNumber,
    streamingSlideTitle,
}: PresentationViewerProps) => {
    const { t } = useLingui();
    const [visibleSlide, setVisibleSlide] = useState<number | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);
    const [hasScrolledToCurrentSlide, setHasScrolledToCurrentSlide] = useState(false);

    const { closePresentation, initialSlide, isOpen, openPresentation } = usePresentationViewerStore();

    const totalSlides = slides.length;

    // Seeding the visible slide is derived from `slides`, so it is adjusted during
    // render; only the scroll listener below needs an effect.
    const [syncedSlides, setSyncedSlides] = useState<typeof slides>();

    if (slides.length > 0 && slides !== syncedSlides) {
        setSyncedSlides(slides);
        setVisibleSlide(slides[0]?.slideNumber ?? null);
    }

    // Scroll-based slide detection
    useEffect(() => {
        if (slides.length === 0) {
            return undefined;
        }

        const handleScroll = () => {
            const scrollArea = document.querySelector("[data-radix-scroll-area-viewport]");

            if (!scrollArea || slides.length === 0) {
                return;
            }

            const { clientHeight, scrollHeight, scrollTop } = scrollArea;

            if (scrollTop <= 10) {
                setVisibleSlide(slides[0]?.slideNumber ?? null);

                return;
            }

            if (scrollTop + clientHeight >= scrollHeight - 10) {
                setVisibleSlide(slides.at(-1)?.slideNumber ?? null);

                return;
            }

            const scrollViewportRect = scrollArea.getBoundingClientRect();

            const viewportCenter = scrollViewportRect.top + scrollViewportRect.height / 2;

            // slides is guaranteed non-empty here (checked at top of useEffect)
            let closestSlide = slides[0] as (typeof slides)[0];
            let smallestDistance = Infinity;

            for (const slide of slides) {
                const slideElement = document.querySelector(`#slide-${slide.slideNumber}`);

                if (!slideElement) {
                    continue;
                }

                const slideRect = slideElement.getBoundingClientRect();
                const slideCenter = slideRect.top + slideRect.height / 2;
                const distanceFromCenter = Math.abs(slideCenter - viewportCenter);

                const isPartiallyVisible = slideRect.bottom > scrollViewportRect.top && slideRect.top < scrollViewportRect.bottom;

                if (isPartiallyVisible && distanceFromCenter < smallestDistance) {
                    smallestDistance = distanceFromCenter;
                    closestSlide = slide;
                }
            }

            setVisibleSlide(closestSlide.slideNumber);
        };

        let scrollTimeout: ReturnType<typeof setTimeout>;
        const debouncedHandleScroll = () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(handleScroll, 50);
        };

        const scrollArea = document.querySelector("[data-radix-scroll-area-viewport]");

        if (scrollArea) {
            scrollArea.addEventListener("scroll", debouncedHandleScroll);
            handleScroll();
        }

        return () => {
            clearTimeout(scrollTimeout);

            if (scrollArea) {
                scrollArea.removeEventListener("scroll", debouncedHandleScroll);
            }
        };
    }, [slides]);

    // Scroll to current slide when data loads
    useEffect(() => {
        if (slides.length > 0 && currentSlideNumber && !hasScrolledToCurrentSlide) {
            const timer = setTimeout(() => {
                const slideElement = document.querySelector(`#slide-${currentSlideNumber}`);

                if (slideElement) {
                    slideElement.scrollIntoView({ behavior: "smooth", block: "center" });
                }

                setHasScrolledToCurrentSlide(true);
            }, 300);

            return () => clearTimeout(timer);
        }

        return undefined;
    }, [slides.length, currentSlideNumber, hasScrolledToCurrentSlide]);

    // Reset scroll tracking when the presentation changes. Adjusting during render (rather than
    // in an effect) means the auto-scroll effect below never observes the stale flag for a frame.
    const [trackedPresentationId, setTrackedPresentationId] = useState(presentationId);

    if (presentationId !== trackedPresentationId) {
        setTrackedPresentationId(presentationId);
        setHasScrolledToCurrentSlide(false);
    }

    const handleDownload = async (format: DownloadFormat) => {
        if (!onDownload) {
            return;
        }

        setIsDownloading(true);

        try {
            await onDownload(format);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleOpenFullScreen = (slideNumber?: number) => {
        openPresentation(presentationId, slideNumber ?? visibleSlide ?? currentSlideNumber ?? 1);
    };

    // Streaming: show real slides + skeleton for the slide being generated.
    let slideBody = (
        <ScrollArea className="h-full">
            <div className="space-y-4 p-4">
                {slides.map((slide) => (
                    <div id={`slide-${slide.slideNumber}`} key={slide.slideNumber}>
                        <PresentationSlideCard
                            className={currentSlideNumber === slide.slideNumber ? "shadow-md ring-2 ring-blue-500/20" : ""}
                            onFullScreenClick={(n) => handleOpenFullScreen(n)}
                            presentationTitle={presentationTitle}
                            slide={slide}
                            totalSlides={totalSlides}
                        />
                    </div>
                ))}
            </div>
        </ScrollArea>
    );

    if (isStreaming) {
        slideBody = (
            <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                    {slides.map((slide) => (
                        <div id={`slide-${slide.slideNumber}`} key={slide.slideNumber}>
                            <PresentationSlideCard
                                className={currentSlideNumber === slide.slideNumber ? "shadow-md ring-2 ring-blue-500/20" : ""}
                                onFullScreenClick={(n) => handleOpenFullScreen(n)}
                                presentationTitle={presentationTitle}
                                slide={slide}
                                totalSlides={totalSlides}
                            />
                        </div>
                    ))}

                    {/* Skeleton for slide being generated */}
                    {streamingSlideNumber && slides.every((s) => s.slideNumber !== streamingSlideNumber) && (
                        <div id={`slide-${streamingSlideNumber}`}>
                            <PresentationSlideSkeleton
                                isGenerating
                                slideNumber={streamingSlideNumber}
                                slideTitle={streamingSlideTitle}
                                streamingContent={streamingContent}
                            />
                        </div>
                    )}

                    {slides.length === 0 && !streamingSlideNumber && (
                        <PresentationSlideSkeleton isGenerating slideNumber={1} slideTitle={streamingSlideTitle} />
                    )}
                </div>
            </ScrollArea>
        );
    } else if (error) {
        slideBody = (
            <div className="flex h-full flex-col items-center justify-center bg-gradient-to-b from-white to-zinc-50 px-6 py-12 dark:from-zinc-950 dark:to-zinc-900">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
                    <AlertTriangle className="h-10 w-10 text-zinc-500 dark:text-zinc-400" />
                </div>
                <h3 className="mb-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                    <Trans>Error</Trans>
                </h3>
                <p className="max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">{error}</p>
            </div>
        );
    } else if (isLoading) {
        slideBody = (
            <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                    {Array.from({ length: 3 }, (_, i) => (
                        <PresentationSlideSkeleton key={i + 1} slideNumber={i + 1} />
                    ))}
                </div>
            </ScrollArea>
        );
    } else if (slides.length === 0) {
        slideBody = (
            <div className="flex h-full flex-col items-center justify-center bg-gradient-to-b from-white to-zinc-50 px-6 py-12 dark:from-zinc-950 dark:to-zinc-900">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
                    <Presentation className="h-10 w-10 text-zinc-500 dark:text-zinc-400" />
                </div>
                <h3 className="mb-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                    <Trans>No slides found</Trans>
                </h3>
                <p className="max-w-md text-center text-sm text-zinc-500 dark:text-zinc-400">
                    <Trans>This presentation doesn&apos;t have any slides yet.</Trans>
                </p>
            </div>
        );
    }

    return (
        <Card className="bg-card flex h-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 py-0 shadow-none">
            {showHeader && (
                <CardHeader className="h-14 space-y-2 border-b bg-zinc-50/80 p-2 px-4 backdrop-blur-sm dark:bg-zinc-900/80">
                    <div className="flex flex-row items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="relative flex-shrink-0 rounded-lg border border-zinc-300 bg-zinc-200/60 p-2 dark:border-zinc-700 dark:bg-zinc-900">
                                <Presentation className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
                            </div>
                            <div className="flex items-center gap-2">
                                <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">{presentationTitle}</CardTitle>
                                {isStreaming && <span className="inline-block h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-blue-500" />}
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            {slides.length > 0 && !isStreaming && (
                                <>
                                    <Button
                                        className="h-8 w-8 p-0"
                                        onClick={() => handleOpenFullScreen()}
                                        size="sm"
                                        title={t`Open in full screen`}
                                        variant="ghost"
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                    </Button>

                                    {onDownload && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                render={
                                                    <Button
                                                        className="h-8 w-8 p-0"
                                                        disabled={isDownloading}
                                                        size="sm"
                                                        title={t`Export presentation`}
                                                        variant="ghost"
                                                    >
                                                        <Download className="h-3.5 w-3.5" />
                                                    </Button>
                                                }
                                            />
                                            <DropdownMenuContent align="end" className="w-32">
                                                <DropdownMenuItem className="cursor-pointer" disabled={isDownloading} onClick={() => handleDownload("pdf")}>
                                                    <FileText className="mr-2 h-4 w-4" />
                                                    PDF
                                                </DropdownMenuItem>
                                                <DropdownMenuItem className="cursor-pointer" disabled={isDownloading} onClick={() => handleDownload("pptx")}>
                                                    <Presentation className="mr-2 h-4 w-4" />
                                                    PPTX
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </CardHeader>
            )}

            <CardContent className="relative h-full flex-1 overflow-hidden p-0">{slideBody}</CardContent>

            <div className="border-border/40 bg-muted/20 flex h-9 items-center justify-between border-t px-4 py-2">
                <div className="text-muted-foreground font-mono text-xs">
                    {isStreaming && (
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 animate-spin rounded-full border border-blue-300 border-t-blue-500" />
                            {streamingSlideNumber ? t`Slide ${streamingSlideNumber}` : t`Generating...`}
                        </span>
                    )}
                    {!isStreaming && slides.length > 0 && visibleSlide && (
                        <span>
                            {visibleSlide}/{slides.length}
                        </span>
                    )}
                </div>
            </div>

            {/* Full Screen Presentation Viewer Modal */}
            <FullScreenPresentationViewer
                initialSlide={initialSlide}
                isOpen={isOpen}
                onClose={closePresentation}
                onDownload={onDownload}
                presentationTitle={presentationTitle}
                slides={slides}
            />
        </Card>
    );
};

export default PresentationViewer;
