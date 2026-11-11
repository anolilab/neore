"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

/**
 * Warms what the "@" and "/" menus show before they open, so they open with it.
 *
 * Once the composer has focus and first paint has passed (`use-after-first-paint.ts`: the menus' reads must not join
 * first paint's burst, `e2e/first-paint.e2e.test.ts`), it prefetches the "@" menu's unfiltered reads with the options
 * and keys `file-mention-popup.tsx` and `use-all-threads-data.ts` use. A prefetch has no observer, so it opens no live
 * subscription: that starts when the menu mounts its query, as before, and answers from this cache. Both reads are the
 * user's, not the chat's, so a cached answer is not fetched again on another chat.
 *
 * Once per page load, not per composer: the composer remounts (and autofocuses) on every chat switch, and the "/" menu's
 * prompts and skills are actions the cache does not keep. Returns `true` in the composer that warmed: its "/" menu loads
 * them then; a later composer's loads on its first "/", as before.
 */
const warmed = { done: false };

const useMentionPrefetch = (editor: Editor | null, enabled: boolean): boolean => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const afterFirstPaint = useAfterFirstPaint();
    const [warm, setWarm] = useState(false);
    const ready = enabled && isAuthenticated && !isLoading && afterFirstPaint && editor !== null;

    useEffect(() => {
        if (!ready || warmed.done) {
            return undefined;
        }

        const prefetch = () => {
            if (warmed.done) {
                return;
            }

            warmed.done = true;
            setWarm(true);
            // A failed prefetch is not an error to show: the menu's own query tries again when it opens.
            void queryClient.prefetchQuery(crpc.vault.functions.getAttachmentsForUser.queryOptions({}));
            void queryClient.prefetchQuery(crpc.chat.composite.getThreadListData.queryOptions({ paginationOpts: THREAD_LIST_PAGINATION_OPTS }));
        };

        if (editor.isFocused) {
            prefetch();

            return undefined;
        }

        editor.on("focus", prefetch);

        return () => {
            editor.off("focus", prefetch);
        };
    }, [ready, editor, crpc, queryClient]);

    return warm;
};

export default useMentionPrefetch;
