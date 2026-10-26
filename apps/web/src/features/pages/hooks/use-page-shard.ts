"use client";

import { isPageShardKnown, notePageShard } from "@neore/client-runtime";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Settle which shard `pageId` lives on before anything queries it — see
 * `useThreadShard`. Returns `true` once the page's calls can go out.
 */
export const usePageShard = (pageId: string): boolean => {
    const crpc = useCRPC();
    const known = isPageShardKnown(pageId);
    const { data, isError, isSuccess } = useQuery({
        ...crpc.pages.sharing.resolvePageShard.queryOptions(known ? skipToken : { pageId }, { live: false }),
        retry: false,
    });

    if (!known && (isSuccess || isError)) {
        notePageShard(pageId, isSuccess ? data : null);
    }

    return known || isSuccess || isError;
};
