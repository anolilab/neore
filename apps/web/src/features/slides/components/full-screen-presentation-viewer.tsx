/**
 * FullScreenPresentationViewer
 * Ported from kortix-ai/suna FullScreenPresentationViewer.tsx
 *
 * Full-screen modal for browsing slides with keyboard navigation.
 * Adapted to load slide data from Lunora instead of sandbox metadata.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Skeleton } from "@neore/ui/components/skeleton";
import { ChevronLeft, ChevronRight, Download, FileText, Pencil, Presentation, SkipBack, SkipForward, X } from "lucide-react";
import React, { useCallback, useEffect, useEffectEvent, useState } from "react";

import { createSlideHtml, SLIDE_HEIGHT, SLIDE_WIDTH } from "../lib/slide-html-template";
import type { DownloadFormat } from "../types";
import SlideEditorDialog from "./slide-editor-dialog";

interface SlideData {
    _id: string;
    htmlContent: string;
    slideNumber: number;
    title: string;
}

interface FullScreenPresentationViewerProps {
    initialSlide?: number;
    isLoading?: boolean;
    isOpen: boolean;
    onClose: () => void;
    onDownload?: (format: DownloadFormat) => Promise<void>;
    presentationTitle?: string;
    slides: SlideData[];
}

interface SlideIframeProps {
    presentationTitle?: string;
    slide: SlideData;
    totalSlides: number;
}

const SlideIframe = React.memo(
    ({ presentationTitle, slide, totalSlides }: SlideIframeProps) => {
        const { t } = useLingui();
        const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
        const [scale, setScale] = useState(1);

        useEffect(() => {
            if (containerRef) {
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

                let resizeTimeout: ReturnType<typeof setTimeout>;
                const debouncedUpdateScale = () => {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(updateScale, 100);
                };

                updateScale();
                window.addEventListener("resize", debouncedUpdateScale);

                return () => {
                    window.removeEventListener("resize", debouncedUpdateScale);
                    clearTimeout(resizeTimeout);
                };
            }

            return undefined;
        }, [containerRef, scale]);

        const { slideNumber, title: slideTitle } = slide;
        const slideHtml = createSlideHtml(slide.htmlContent, slide.slideNumber, totalSlides, presentationTitle ?? t`Presentation`);

        return (
            <div className="flex h-full w-full items-center justify-center bg-transparent">
                <div
                    className="relative overflow-hidden rounded-lg bg-transparent"
                    ref={setContainerRef}
                    style={{
                        aspectRatio: "16 / 9",
                        contain: "layout style",
                        containIntrinsicSize: `${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px`,
                        maxHeight: "100%",
                        maxWidth: "100%",
                        width: "100%",
                    }}
                >
                    <iframe
                        className="rounded-xl border-0"
                        key={`slide-${slide.slideNumber}`}
                        sandbox="allow-scripts allow-modals"
                        srcDoc={slideHtml}
                        style={{
                            backfaceVisibility: "hidden",
                            border: "none",
                            display: "block",
                            height: `${SLIDE_HEIGHT}px`,
                            left: `calc((100% - ${SLIDE_WIDTH * scale}px) / 2)`,
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
        );
    },
    (previousProps, nextProps) =>
        previousProps.slide.slideNumber === nextProps.slide.slideNumber &&
        previousProps.slide.htmlContent === nextProps.slide.htmlContent &&
        previousProps.totalSlides === nextProps.totalSlides &&
        previousProps.presentationTitle === nextProps.presentationTitle,
);

SlideIframe.displayName = "SlideIframe";

const FullScreenPresentationViewer = ({
    initialSlide = 1,
    isLoading = false,
    isOpen,
    onClose,
    onDownload,
    presentationTitle,
    slides,
}: FullScreenPresentationViewerProps) => {
    const { t } = useLingui();
    const [currentSlide, setCurrentSlide] = useState(initialSlide);
    const [isDownloading, setIsDownloading] = useState(false);
    const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

    const totalSlides = slides.length;

    // Sync currentSlide with initialSlide when the modal opens. Adjusted during
    // render rather than in an effect, so the first painted frame is the right slide.
    const [wasOpen, setWasOpen] = useState(false);

    if (isOpen !== wasOpen) {
        setWasOpen(isOpen);

        if (isOpen) {
            setCurrentSlide(initialSlide);
        }
    }

    // Navigation
    const goToNextSlide = useCallback(() => {
        if (currentSlide < totalSlides) {
            setCurrentSlide((previous) => previous + 1);
        }
    }, [currentSlide, totalSlides]);

    const goToPreviousSlide = useCallback(() => {
        if (currentSlide > 1) {
            setCurrentSlide((previous) => previous - 1);
        }
    }, [currentSlide]);

    const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
        const handledKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Home", "End", "Escape"];

        if (handledKeys.includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
        }

        switch (e.key) {
            case " ":
            case "ArrowDown":
            case "ArrowRight": {
                goToNextSlide();
                break;
            }
            case "ArrowLeft":
            case "ArrowUp": {
                goToPreviousSlide();
                break;
            }
            case "End": {
                setCurrentSlide(totalSlides);
                break;
            }
            case "Escape": {
                onClose();
                break;
            }
            case "Home": {
                setCurrentSlide(1);
                break;
            }
            default: {
                break;
            }
        }
    });

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const handleKeyDown = (e: KeyboardEvent) => onKeyDown(e);

        document.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [isOpen]);

    if (!isOpen) {
        return null;
    }

    // Download
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

    const currentSlideData = slides.find((s) => s.slideNumber === currentSlide);

    const renderSlide = currentSlideData ? <SlideIframe presentationTitle={presentationTitle} slide={currentSlideData} totalSlides={totalSlides} /> : null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm">
            {/* Top Controls Bar */}
            <div className="flex-shrink-0 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                        <div className="relative flex-shrink-0 rounded-lg border border-zinc-300 bg-zinc-200/60 p-2 dark:border-zinc-700 dark:bg-zinc-900">
                            <Presentation className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
                        </div>

                        {(presentationTitle || totalSlides > 0) && (
                            <div>
                                <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">{presentationTitle ?? t`Presentation`}</h1>
                                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                                    <Trans>
                                        Slide {currentSlide} of {totalSlides}
                                    </Trans>
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Edit slide button */}
                        {currentSlideData && (
                            <Button className="h-8 w-8 p-0" onClick={() => setIsEditDialogOpen(true)} size="sm" title={t`Edit current slide`} variant="ghost">
                                <Pencil className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* Export dropdown */}
                        {onDownload && (
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <Button className="h-8 w-8 p-0" disabled={isDownloading} size="sm" title={t`Export presentation`} variant="ghost">
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

                        {/* Close button */}
                        <Button className="h-8 w-8 p-0" onClick={onClose} size="sm" title={t`Close full screen`} variant="ghost">
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Slide Editor Dialog */}
            {currentSlideData && (
                <SlideEditorDialog
                    htmlContent={currentSlideData.htmlContent}
                    onOpenChange={setIsEditDialogOpen}
                    open={isEditDialogOpen}
                    slideId={currentSlideData._id}
                    slideNumber={currentSlideData.slideNumber}
                    title={currentSlideData.title}
                />
            )}

            {/* Main Content Area */}
            <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 p-2 dark:bg-zinc-900">
                {isLoading || !currentSlideData ? (
                    <div className="text-center">
                        <Skeleton className="mx-auto mb-4 h-12 w-12 rounded-full" />
                        <p className="text-zinc-700 dark:text-zinc-300">
                            <Trans>Loading presentation...</Trans>
                        </p>
                    </div>
                ) : (
                    <div className="flex h-full w-full flex-col">
                        {/* Presentation Container */}
                        <div className="flex-1 overflow-hidden rounded-xl bg-transparent" style={{ aspectRatio: "16 / 9" }}>
                            {renderSlide}
                        </div>

                        {/* Controls below presentation */}
                        <div className="mt-3 flex items-center justify-between px-4">
                            {/* Left Controls */}
                            <div className="flex items-center gap-2">
                                <Button
                                    aria-label={t`First slide`}
                                    className="h-8 w-8 p-0 disabled:opacity-50"
                                    disabled={currentSlide <= 1}
                                    onClick={() => setCurrentSlide(1)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <SkipBack className="h-3.5 w-3.5" />
                                </Button>

                                <Button
                                    aria-label={t`Previous slide`}
                                    className="h-8 w-8 p-0 disabled:opacity-50"
                                    disabled={currentSlide <= 1}
                                    onClick={goToPreviousSlide}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                            </div>

                            {/* Center - Slide Indicators */}
                            <div className="flex items-center">
                                <div className="flex gap-2">
                                    {slides.map(({ slideNumber }) => (
                                        <button
                                            aria-current={slideNumber === currentSlide ? "true" : undefined}
                                            aria-label={t`Go to slide ${slideNumber}`}
                                            className={`h-2.5 w-2.5 rounded-full transition-all duration-200 ${
                                                slideNumber === currentSlide
                                                    ? "bg-black dark:bg-white"
                                                    : "bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-600 dark:hover:bg-zinc-500"
                                            }`}
                                            key={slideNumber}
                                            onClick={() => setCurrentSlide(slideNumber)}
                                            type="button"
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* Right Controls */}
                            <div className="flex items-center gap-2">
                                <Button
                                    aria-label={t`Next slide`}
                                    className="h-8 w-8 p-0 disabled:opacity-50"
                                    disabled={currentSlide >= totalSlides}
                                    onClick={goToNextSlide}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>

                                <Button
                                    aria-label={t`Last slide`}
                                    className="h-8 w-8 p-0 disabled:opacity-50"
                                    disabled={currentSlide >= totalSlides}
                                    onClick={() => setCurrentSlide(totalSlides)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <SkipForward className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FullScreenPresentationViewer;
