"use client";

/**
 * PPTX Preview Component
 *
 * Renders a preview of PowerPoint (.pptx) files by extracting slide
 * content and displaying it as a card-based layout.
 *
 * PPTX files are ZIP archives containing XML. We parse the key XML files:
 * - ppt/presentation.xml — slide list and order
 * - ppt/slides/slide{N}.xml — individual slide content (text, shapes)
 * - ppt/slides/_rels/slide{N}.xml.rels — relationships (images, links)
 *
 * This is a lightweight preview — not a full PowerPoint renderer.
 * For full fidelity, users should download and open in PowerPoint/Google Slides.
 *
 * Code-split: Import lazily to avoid including JSZip in the main bundle.
 */
import { Plural, useLingui } from "@lingui/react/macro";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PptxPreviewProps {
    /** Additional CSS class. */
    className?: string;
    /** PPTX file as ArrayBuffer or Blob. */
    data: ArrayBuffer | Blob;
    /** File name for display. */
    fileName?: string;
}

interface SlideContent {
    index: number;
    notes?: string;
    texts: string[];
}

// ---------------------------------------------------------------------------
// PPTX Parser (uses dynamic import for JSZip)
// ---------------------------------------------------------------------------

const SLIDE_PATH_REGEX = /^ppt\/slides\/slide\d+\.xml$/;
const SLIDE_NUMBER_REGEX = /slide(\d+)/;

const parsePptxSlides = async (data: ArrayBuffer | Blob): Promise<SlideContent[]> => {
    const { default: JSZip } = await import("jszip");

    const arrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const zip = await JSZip.loadAsync(arrayBuffer);

    const slides: SlideContent[] = [];

    // Find all slide files
    const slideFiles = Object.keys(zip.files)
        .filter((name) => SLIDE_PATH_REGEX.test(name))
        .toSorted((a, b) => {
            const numberA = Number(a.match(SLIDE_NUMBER_REGEX)?.[1] ?? "0");
            const numberB = Number(b.match(SLIDE_NUMBER_REGEX)?.[1] ?? "0");

            return numberA - numberB;
        });

    for (const [i, slideFile] of slideFiles.entries()) {
        const zipEntry = zip.file(slideFile);
        const xmlContent = zipEntry ? await zipEntry.async("string") : null;

        if (!xmlContent) {
            continue;
        }

        // Extract text by paragraph breaks in the XML
        const paragraphMatches = xmlContent.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g);
        const paragraphTexts: string[] = [];

        for (const pMatch of paragraphMatches) {
            const paraContent = pMatch[1] ?? "";
            const textInPara: string[] = [];
            const innerTexts = paraContent.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g);

            for (const t of innerTexts) {
                const cleaned = (t[1] ?? "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').trim();

                if (cleaned) {
                    textInPara.push(cleaned);
                }
            }

            if (textInPara.length > 0) {
                paragraphTexts.push(textInPara.join(""));
            }
        }

        slides.push({
            index: i + 1,
            texts: paragraphTexts,
        });
    }

    return slides;
};

// ---------------------------------------------------------------------------
// Slide Card
// ---------------------------------------------------------------------------

const SlideCard: FC<{
    isActive: boolean;
    onClick: () => void;
    slide: SlideContent;
}> = memo(({ isActive, onClick, slide }) => {
    const { t } = useLingui();
    const slideNumber = slide.index;
    const moreLines = slide.texts.length - 5;

    return (
        <button
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
                isActive
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                    : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
            }`}
            onClick={onClick}
            type="button"
        >
            <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t`Slide ${slideNumber}`}</span>
            </div>
            {slide.texts.length > 0 ? (
                <div className="space-y-1">
                    {slide.texts.slice(0, 5).map((text, i) => (
                        <p className={`truncate text-sm ${i === 0 ? "font-medium" : "text-gray-600 dark:text-gray-400"}`} key={i}>
                            {text}
                        </p>
                    ))}
                    {slide.texts.length > 5 && <p className="text-xs text-gray-400">{t`+${moreLines} more lines`}</p>}
                </div>
            ) : (
                <p className="text-sm text-gray-400 italic">{t`No text content`}</p>
            )}
        </button>
    );
});

SlideCard.displayName = "SlideCard";

// ---------------------------------------------------------------------------
// Main Slide View
// ---------------------------------------------------------------------------

const SlideView: FC<{ slide: SlideContent }> = memo(({ slide }) => {
    const { t } = useLingui();

    return (
        <div className="flex aspect-video flex-col justify-center rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
            {slide.texts.length > 0 ? (
                <div className="space-y-3">
                    {slide.texts.map((text, i) => (
                        <p className={i === 0 ? "text-2xl font-bold text-gray-900 dark:text-gray-100" : "text-base text-gray-700 dark:text-gray-300"} key={i}>
                            {text}
                        </p>
                    ))}
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center text-gray-400">
                    <FileIcon aria-hidden="true" className="mb-2 h-12 w-12" />
                    <p>{t`No text content on this slide`}</p>
                </div>
            )}
        </div>
    );
});

SlideView.displayName = "SlideView";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const PptxPreview: FC<PptxPreviewProps> = memo(({ className, data, fileName }) => {
    const { t } = useLingui();
    const [slides, setSlides] = useState<SlideContent[]>([]);
    const [activeSlide, setActiveSlide] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [previousData, setPreviousData] = useState(data);

    // Reset the load state during render when the source changes, so the previous
    // deck's slides are never shown against the new file's spinner.
    if (data !== previousData) {
        setPreviousData(data);
        setLoading(true);
        setError(null);
    }

    useEffect(() => {
        const parse = async () => {
            try {
                const parsed = await parsePptxSlides(data);

                setSlides(parsed);
                setLoading(false);
            } catch (error_) {
                setError(error_ instanceof Error ? error_.message : t`Failed to parse PPTX`);
                setLoading(false);
            }
        };

        parse();
    }, [data, t]);

    const goToSlide = useCallback(
        (direction: "prev" | "next") => {
            setActiveSlide((prev) => {
                if (direction === "prev") {
                    return Math.max(0, prev - 1);
                }

                return Math.min(slides.length - 1, prev + 1);
            });
        },
        [slides.length],
    );

    if (loading) {
        return (
            <div className={`flex items-center justify-center p-8 ${className ?? ""}`}>
                <div className="animate-pulse text-gray-400">{t`Loading presentation…`}</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className={`flex items-center justify-center p-8 text-red-500 ${className ?? ""}`}>
                <p>{t`Error: ${error}`}</p>
            </div>
        );
    }

    if (slides.length === 0) {
        return (
            <div className={`flex items-center justify-center p-8 text-gray-400 ${className ?? ""}`}>
                <p>{t`No slides found in this presentation.`}</p>
            </div>
        );
    }

    return (
        <div className={`flex flex-col gap-4 ${className ?? ""}`}>
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileIcon aria-hidden="true" className="h-4 w-4 text-orange-500" />
                    <span className="text-sm font-medium">{fileName ?? t`Presentation`}</span>
                    <span className="text-xs text-gray-400">
                        (<Plural one="# slide" other="# slides" value={slides.length} />)
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        aria-label={t`Previous slide`}
                        className="rounded p-1 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"
                        disabled={activeSlide === 0}
                        onClick={() => goToSlide("prev")}
                        type="button"
                    >
                        <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <span className="text-xs text-gray-500">
                        {activeSlide + 1} / {slides.length}
                    </span>
                    <button
                        aria-label={t`Next slide`}
                        className="rounded p-1 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"
                        disabled={activeSlide === slides.length - 1}
                        onClick={() => goToSlide("next")}
                        type="button"
                    >
                        <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {/* Active Slide */}
            <SlideView slide={slides[activeSlide]!} />

            {/* Slide Thumbnails */}
            <div className="grid max-h-64 grid-cols-2 gap-2 overflow-auto sm:grid-cols-3 md:grid-cols-4">
                {slides.map((slide, i) => (
                    <SlideCard isActive={i === activeSlide} key={slide.index} onClick={() => setActiveSlide(i)} slide={slide} />
                ))}
            </div>
        </div>
    );
});

PptxPreview.displayName = "PptxPreview";

export { PptxPreview };
export type { PptxPreviewProps };
