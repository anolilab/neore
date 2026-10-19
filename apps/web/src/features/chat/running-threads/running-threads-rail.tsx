import { useLingui } from "@lingui/react/macro";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { useCRPC } from "@/lib/lunora/crpc";
import { isNativeShell } from "@/lib/native/bridge";

import { runningThreads } from "./running-threads";

/**
 * Desktop-only strip listing the threads with a run in flight, so parallel
 * work stays visible and one click away. Reads the sidebar's thread-list query
 * (same key, so no extra request) and writes nothing.
 */
const RunningThreadsRail = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const native = isNativeShell();
    const { data } = useQuery(crpc.chat.composite.getThreadListData.queryOptions(native ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken));

    const running = native ? runningThreads(data?.threads.page ?? []) : [];

    if (running.length === 0) {
        return null;
    }

    return (
        <nav aria-label={t`Running threads`} className="flex shrink-0 gap-2 overflow-x-auto px-3 py-1">
            {running.map((thread) => {
                const title = thread.title || t`New Chat`;

                return (
                    <Link
                        aria-label={t`${title} (running)`}
                        className="bg-muted hover:bg-accent flex max-w-48 shrink-0 items-center gap-2 rounded-full px-3 py-1 text-xs"
                        key={thread._id}
                        params={{ threadId: thread._id }}
                        to="/chat/$threadId"
                    >
                        <span aria-hidden="true" className="bg-primary size-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
                        <span className="truncate">{title}</span>
                    </Link>
                );
            })}
        </nav>
    );
};

export default RunningThreadsRail;
