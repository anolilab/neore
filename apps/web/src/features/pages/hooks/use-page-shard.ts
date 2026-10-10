"use client";

import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";
import { isPageShardKnown, notePageShard } from "@/lib/lunora/shard-routing";

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
