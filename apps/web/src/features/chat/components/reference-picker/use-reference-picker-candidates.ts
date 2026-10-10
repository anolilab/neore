"use client";

import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

export type ReferencePickerScope = "all" | "thread";

export type ReferencePickerItem = {
    createdAt: number;
    id: string;
    mimeType: string;
    source: "document" | "generated" | "uploaded";
    threadId: null | string;
    threadTitle: null | string;
    thumbnailUrl: null | string;
    url: string;
};

interface UseReferencePickerCandidatesOptions {
    enabled: boolean;
    numItems?: number;
    scope: ReferencePickerScope;
    threadId?: string;
}

/**
 * Whether the picker query may fire. `scope="thread"` without a `threadId`
 * would 400 on the server, so the query stays disabled in that case.
 */
export const isReferencePickerReady = (enabled: boolean, scope: ReferencePickerScope, threadId?: string): boolean =>
    enabled && (scope === "all" || Boolean(threadId));

/**
 * Single-page fetcher for the reference picker grid.
 *
 * The picker only ever shows the most recent N candidates — the full Library
 * view (Tier 3 #9) will get its own paginated experience. We deliberately do
 * not chain cursor pages here.
 */
const useReferencePickerCandidates = ({ enabled, numItems: numberItems = 60, scope, threadId }: UseReferencePickerCandidatesOptions) => {
    const crpc = useCRPC();

    const isReady = isReferencePickerReady(enabled, scope, threadId);

    return useQuery(
        crpc.media.functions.listUserImages.queryOptions(
            isReady
                ? {
                      paginationOpts: { cursor: null, numItems: numberItems },
                      scope,
                      // `threadId` is the `/chat/$threadId` route param, forwarded as a
                      // plain string by the composer.
                      threadId: scope === "thread" ? (threadId as Id<"threads">) : undefined,
                  }
                : skipToken,
        ),
    );
};

export default useReferencePickerCandidates;
