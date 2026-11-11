"use client";

import { useAuth as useLunoraIdentity } from "@lunora/react";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Warms what the "@" and "/" menus show before they open, so they open with it.
 *
 * Once the composer has focus and first paint has passed (`use-after-first-paint.ts`: the menus' reads must not join
 * first paint's burst, `e2e/first-paint.e2e.test.ts`), it prefetches the "@" menu's unfiltered reads with the options
 * and keys `file-mention-popup.tsx` and `use-all-threads-data.ts` use. A prefetch has no observer, so it opens no live
 * subscription: that starts when the menu mounts its query, as before, and answers from this cache.
 *
 * The cache decides, not a flag: a read is fetched when the cache has no answer and none on its way. So a composer
 * remounted by a chat switch fetches nothing, while a cache cleared at sign-out, an entry collected after five unobserved
 * minutes, or a failed prefetch is fetched again on the next focus. It waits for the client's token: the cookie-backed
 * `isAuthenticated` reads true before the token is adopted, and a tokenless read fails.
 *
 * Returns `true` once this composer found the files read missing: its "/" menu loads the prompts and skills (actions the
 * cache does not keep) then. A composer that found the cache warm loads them on its first "/", as before, so a chat
 * switch does not cost two actions.
 */
const useMentionPrefetch = (editor: Editor | null, enabled: boolean): boolean => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const { token } = useLunoraIdentity();
    const afterFirstPaint = useAfterFirstPaint();
    const [warm, setWarm] = useState(false);
    const ready = enabled && token !== null && afterFirstPaint && editor !== null;

    useEffect(() => {
        if (!ready) {
            return undefined;
        }

        const isHeld = (queryKey: QueryKey): boolean => {
            const state = queryClient.getQueryState(queryKey);

            return state?.data !== undefined || state?.fetchStatus === "fetching";
        };

        // A failed prefetch is not an error to show: it leaves the cache empty, so the next focus or the menu tries again.
        const prefetch = () => {
            const files = crpc.vault.functions.getAttachmentsForUser.queryOptions({});
            const threads = crpc.chat.composite.getThreadListData.queryOptions({ paginationOpts: THREAD_LIST_PAGINATION_OPTS });

            if (!isHeld(threads.queryKey)) {
                void queryClient.prefetchQuery(threads);
            }

            if (!isHeld(files.queryKey)) {
                setWarm(true);
                void queryClient.prefetchQuery(files);
            }
        };

        if (editor.isFocused) {
            prefetch();
        }

        editor.on("focus", prefetch);

        return () => {
            editor.off("focus", prefetch);
        };
    }, [ready, editor, crpc, queryClient]);

    return warm;
};

export default useMentionPrefetch;
