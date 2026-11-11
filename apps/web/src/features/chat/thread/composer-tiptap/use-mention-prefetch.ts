"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

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
 * Returns `true` from then on: the "/" menu loads its prompts and skills (actions, not cached queries) on it.
 */
const useMentionPrefetch = (editor: Editor | null, enabled: boolean): boolean => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const afterFirstPaint = useAfterFirstPaint();
    const [warm, setWarm] = useState(false);
    const doneRef = useRef(false);
    const ready = enabled && isAuthenticated && !isLoading && afterFirstPaint && editor !== null;

    useEffect(() => {
        if (!ready || doneRef.current) {
            return undefined;
        }

        const prefetch = () => {
            if (doneRef.current) {
                return;
            }

            doneRef.current = true;
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
