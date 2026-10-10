import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useLocation, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import Assistant from "@/features/chat/assistant";
import { DEFAULT_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { useThreadShard } from "@/features/chat/sharing/use-thread-shard";
import { createLunoraActionQueryOptions, createLunoraQueryOptions, useCRPC } from "@/lib/lunora/crpc";
import { isLunoraId, LUNORA_ID_SOURCE } from "@/lib/lunora/ids";

const CHAT_THREAD_PATH_RE = new RegExp(`/chat/(${LUNORA_ID_SOURCE})(?:/|$)`);

const ChatPage = () => {
    const route = "/(chat)/chat/$threadId";

    const context = useRouteContext({ from: route });
    const routeThreadId = Route.useParams({ select: ({ threadId }) => threadId });
    const initialMessage = Route.useSearch({ select: ({ initialMessage: selected }) => selected });
    const loaderData = Route.useLoaderData();
    const location = useLocation();
    const { t } = useLingui();

    // CRITICAL: TanStack Router params can lag behind the URL during navigation.
    // Extract threadId directly from pathname to ensure we always have the correct value.
    // This prevents showing stale thread data when switching threads.
    const threadId = (() => {
        const match = location.pathname.match(CHAT_THREAD_PATH_RE);

        return match?.[1] ?? routeThreadId;
    })();

    // Get thread from loader data for immediate display (no loading flash)
    const initialThread = loaderData?.thread ?? null;

    // A public thread opened by someone who is neither owner nor grantee comes
    // back REDACTED — no `userId`, but its `publicAccessToken`. That viewer
    // belongs on the read-only share page, not in a composer they cannot use.
    const crpc = useCRPC();
    const navigate = useNavigate();
    // A thread shared with the caller lives on its owner's shard; nothing about
    // it may be queried until that is settled (`use-thread-shard.ts`).
    const shardReady = useThreadShard(threadId, initialThread === null);
    const { data: viewedThread } = useQuery(crpc.chat.functions.getThread.queryOptions(shardReady ? { threadId: threadId as Id<"threads"> } : skipToken));
    // Someone else's public thread is not on the viewer's shard at all, so
    // `getThread` answers not-found; its share token is then looked up across
    // shards (`chat_sharing.getThreadShareToken`).
    const { data: crossShardToken } = useQuery({
        ...createLunoraActionQueryOptions(context.lunoraClient, api.chat.sharing.getThreadShareToken, { threadId: threadId as Id<"threads"> }),
        enabled: viewedThread === null,
        retry: 2,
        staleTime: 30_000,
    });
    const redactedToken = viewedThread && viewedThread.isPublic && !viewedThread.userId ? viewedThread.publicAccessToken : undefined;
    const shareToken = redactedToken ?? crossShardToken ?? undefined;

    useEffect(() => {
        if (shareToken) {
            void navigate({ params: { token: shareToken }, replace: true, to: "/thread/$token" });
        }
    }, [navigate, shareToken]);

    useEffect(() => {
        const supportedParams = new Set(["initialMessage", "promptId", "redirectReason", "settings", "settingsTab"]);
        const searchParams = new URLSearchParams(location.search);
        const unsupportedParams: string[] = [];

        for (const [key] of searchParams) {
            if (!supportedParams.has(key)) {
                unsupportedParams.push(key);
            }
        }

        if (unsupportedParams.length > 0) {
            toast.warning(
                t`${plural(unsupportedParams.length, { one: "Unsupported query parameter", other: "Unsupported query parameters" })}: ${unsupportedParams.join(", ")}`,
            );
        }
    }, [location.search, t]);

    if (!shardReady) {
        return null;
    }

    return (
        <RouteErrorBoundary routeName={route}>
            <Assistant initialMessage={initialMessage} initialThread={initialThread} jwtToken={context.token as string} threadId={threadId} />
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/chat/$threadId")({
    validateSearch: (search: Record<string, unknown>) => {
        return {
            initialMessage: search.initialMessage as string | undefined,
        };
    },
    component: ChatPage,
    staleTime: 5 * 60 * 1000,
    preloadStaleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    // Validate threadId and redirect if invalid
    ssr: true,
    // Non-blocking loader: return cached data immediately, components handle loading
    beforeLoad: ({ params, location }) => {
        const isValidId = isLunoraId(params.threadId);

        if (!isValidId) {
            const searchString = typeof location.search === "string" ? location.search : "";
            const searchParams = new URLSearchParams(searchString);

            throw redirect({
                to: "/chat",
                search: {
                    promptId: searchParams.get("promptId") ?? undefined,
                    redirectReason: "invalid-thread-id",
                },
                replace: true,
            });
        }
    },
    // Enable SSR for instant first load (data in HTML)
    loader: ({ context, params, location }): { messages: Record<string, object> | null; thread: Record<string, object> | null } => {
        const routerState = location.state as { isNewThread?: boolean } | undefined;

        if (routerState?.isNewThread) {
            return { thread: null, messages: null };
        }

        if (!context.isAuthenticated) {
            return { thread: null, messages: null };
        }

        // INSTANT: Return cached data only (never await)
        const cachedData = context.queryClient.getQueryData(
            createLunoraQueryOptions(context.lunoraClient, api.chat.composite.getThreadWithData, {
                // `params.threadId` is the raw URL segment; beforeLoad above already asserts it is
                // a Lunora row id (UUID), so the brand holds.
                threadId: params.threadId as Id<"threads">,
                messageOpts: { cursor: null, numItems: 20 },
            }).queryKey,
        ) as { messages?: unknown; thread?: unknown } | undefined;

        if (cachedData?.thread) {
            // Prime individual caches for components
            context.queryClient.setQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThread, { threadId: params.threadId as Id<"threads"> }).queryKey,
                cachedData.thread,
            );
            context.queryClient.setQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThreadUIMessages, {
                    threadId: params.threadId as Id<"threads">,
                    paginationOpts: DEFAULT_PAGINATION_OPTS,
                }).queryKey,
                cachedData.messages,
            );

            return { thread: cachedData.thread as Record<string, object>, messages: (cachedData.messages as Record<string, object>) ?? null };
        }

        // No cached data - component will show loading state
        return { thread: null, messages: null };
    },
});
