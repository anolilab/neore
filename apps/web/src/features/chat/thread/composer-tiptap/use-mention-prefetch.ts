"use client";

import { useAuth as useLunoraIdentity } from "@lunora/react";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Warms what the "@" and "/" menus show before they open, so they open with it.
 *
 * Once per composer, on the first edit that leaves text in it: not on focus, which the composer takes on every chat load,
 * and not on an edit that empties it (a send's `clearContent()`). The files read (up to 500 rows, each with a signed URL)
 * is not worth it for someone who only reads. An edit made earlier is remembered, and the reads start once first paint
 * has passed (`use-after-first-paint.ts`: the menus' reads must not join first paint's burst,
 * `e2e/first-paint.e2e.test.ts`) and the client holds its token (the cookie-backed `isAuthenticated` reads true before
 * the token is adopted, and a tokenless read fails).
 *
 * It prefetches the "@" menu's unfiltered reads with the options and keys `file-mention-popup.tsx` and
 * `use-all-threads-data.ts` use. A prefetch has no observer, so it opens no live subscription: that starts when the menu
 * mounts its query, as before, and answers from this cache, or joins the prefetch still on its way. A read the cache holds
 * or is fetching is not sent again, so a composer remounted by a chat switch fetches nothing. One that failed is not
 * retried on later keystrokes: the menu's own query tries when it opens, and the next composer tries once more.
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
    const [typed, setTyped] = useState(false);
    const [warm, setWarm] = useState(false);
    const prefetched = useRef(false);

    useEffect(() => {
        if (!enabled || editor === null || typed) {
            return undefined;
        }

        const onUpdate = () => {
            if (!editor.isEmpty) {
                setTyped(true);
            }
        };

        editor.on("update", onUpdate);

        return () => {
            editor.off("update", onUpdate);
        };
    }, [enabled, editor, typed]);

    useEffect(() => {
        if (!enabled || !typed || token === null || !afterFirstPaint || prefetched.current) {
            return;
        }

        prefetched.current = true;

        const isHeld = (queryKey: QueryKey): boolean => {
            const state = queryClient.getQueryState(queryKey);

            return state?.data !== undefined || state?.fetchStatus === "fetching";
        };
        const files = crpc.vault.functions.getAttachmentsForUser.queryOptions({});
        const threads = crpc.chat.composite.getThreadListData.queryOptions({ paginationOpts: THREAD_LIST_PAGINATION_OPTS });

        // A failed prefetch is not an error to show: it leaves the cache empty, and the menu's own query tries when it opens.
        if (!isHeld(threads.queryKey)) {
            void queryClient.prefetchQuery(threads);
        }

        if (!isHeld(files.queryKey)) {
            setWarm(true);
            void queryClient.prefetchQuery(files);
        }
    }, [enabled, typed, token, afterFirstPaint, crpc, queryClient]);

    return warm;
};

export default useMentionPrefetch;
