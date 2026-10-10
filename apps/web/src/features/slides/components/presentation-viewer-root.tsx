"use client";

/**
 * PresentationViewerRoot
 *
 * Root-level component that bridges the Zustand store (which tracks which
 * presentation is open) with actual Lunora data fetching and the full-screen viewer.
 *
 * Mount this once at the chat layout level. When a PresentationArtifact card
 * is clicked, it calls `openPresentation(id)` on the store — this component
 * detects that, fetches the data, and renders FullScreenPresentationViewer.
 *
 * Also auto-opens the viewer when a presentation is actively generating in the
 * current thread (detected via `useGeneratingPresentation`).
 */

import { useEffect, useRef } from "react";

import { useCurrentThreadId } from "@/features/chat/core/stores/thread-store-hooks";

import { useGeneratingPresentation, usePresentationData } from "../hooks/use-presentation-data";
import usePresentationViewerStore from "../hooks/use-presentation-viewer-store";
import { downloadPresentation } from "../lib/presentation-utilities";
import type { DownloadFormat } from "../types";
import FullScreenPresentationViewer from "./full-screen-presentation-viewer";

const PresentationViewerRoot = () => {
    const { closePresentation, initialSlide, isOpen, openPresentation, presentationId } = usePresentationViewerStore();

    // Auto-open: detect generating presentations in the current thread
    const threadId = useCurrentThreadId();
    const generatingPresentation = useGeneratingPresentation(threadId);
    const autoOpenedRef = useRef<string | null>(null);

    useEffect(() => {
        if (!generatingPresentation) {
            // Reset tracker when no presentation is generating
            autoOpenedRef.current = null;

            return;
        }

        const genId = generatingPresentation._id as string;

        // Only auto-open once per presentation to avoid fighting with manual close
        if (autoOpenedRef.current !== genId && !isOpen) {
            autoOpenedRef.current = genId;
            openPresentation(genId, 1);
        }
    }, [generatingPresentation, isOpen, openPresentation]);

    const { isLoading, presentation, slides } = usePresentationData(isOpen ? presentationId : undefined);

    if (!isOpen) {
        return null;
    }

    const handleDownload = async (format: DownloadFormat) => {
        if (!presentation || slides.length === 0) {
            return;
        }

        await downloadPresentation(format, presentation.title, slides);
    };

    return (
        <FullScreenPresentationViewer
            initialSlide={initialSlide}
            isLoading={isLoading}
            isOpen={isOpen}
            onClose={closePresentation}
            onDownload={handleDownload}
            presentationTitle={presentation?.title}
            slides={slides}
        />
    );
};

export default PresentationViewerRoot;
