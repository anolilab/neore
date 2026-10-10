import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

/**
 * Hook to fetch presentation metadata and slides from Lunora via cRPC.
 *
 * Because these are Lunora queries, the data automatically re-subscribes
 * when slides are added or the presentation status changes — giving us
 * real-time streaming for free during generation.
 */

("use client");

// `presentationId`/`threadId` reach these hooks as plain strings (route params and
// props from the canvas panel); they are always ids the backend handed out, so the
// brand is re-applied at the query boundary. `shouldQuery` guarantees non-empty.
export const usePresentationData = (presentationId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();

    const shouldQuery = isAuthenticated && !isAuthLoading && !!presentationId;

    const {
        data: presentation,
        error: presentationError,
        isLoading: isPresentationLoading,
    } = useQuery(crpc.chat.slides.functions.getPresentation.queryOptions(shouldQuery ? { presentationId: presentationId as Id<"presentations"> } : skipToken));

    const {
        data: slides,
        error: slidesError,
        isLoading: isSlidesLoading,
    } = useQuery(
        crpc.chat.slides.functions.getPresentationSlides.queryOptions(shouldQuery ? { presentationId: presentationId as Id<"presentations"> } : skipToken),
    );

    const isLoading = isPresentationLoading || isSlidesLoading;
    const error = presentationError || slidesError;
    const isGenerating = presentation?.status === "generating";

    return {
        error: error ? (error as Error).message : null,
        isGenerating,
        isLoading,
        presentation,
        slides: slides ?? [],
    };
};

/**
 * Hook to detect if a presentation is currently being generated in a thread.
 * Used during AI streaming to auto-open the viewer showing real-time progress.
 */
export const useGeneratingPresentation = (threadId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();

    const shouldQuery = isAuthenticated && !isAuthLoading && !!threadId;

    const { data: generatingPresentation } = useQuery(
        crpc.chat.slides.functions.getGeneratingPresentation.queryOptions(shouldQuery ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    return generatingPresentation ?? null;
};
