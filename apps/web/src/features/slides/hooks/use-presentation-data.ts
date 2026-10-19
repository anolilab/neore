import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";
import { useUnlockProof } from "@neore/client-runtime";

/**
 * Arguments for the deck reads. A deck is gated on its CHAT: a deck in a locked
 * chat needs that chat's proof, which is passed explicitly here because the deck
 * id alone does not name the chat.
 */
export const deckQueryArgs = (presentationId: string, unlockProof: string | undefined) => {
    return { presentationId: presentationId as Id<"presentations">, unlockProof };
};

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
export const usePresentationData = (presentationId: string | undefined, threadId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();
    // The containing chat's live proof: a deck in a locked chat opens once that chat is unlocked.
    const unlockProof = useUnlockProof(threadId);

    const shouldQuery = isAuthenticated && !isAuthLoading && !!presentationId;

    const {
        data: presentation,
        error: presentationError,
        isLoading: isPresentationLoading,
    } = useQuery(crpc.chat.slides.functions.getPresentation.queryOptions(shouldQuery ? deckQueryArgs(presentationId, unlockProof) : skipToken));

    const {
        data: slides,
        error: slidesError,
        isLoading: isSlidesLoading,
    } = useQuery(crpc.chat.slides.functions.getPresentationSlides.queryOptions(shouldQuery ? deckQueryArgs(presentationId, unlockProof) : skipToken));

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
