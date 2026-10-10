import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation as useReactQueryMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC, useLunoraActionOptions, useLunoraAuth } from "@/lib/lunora/crpc";

import { THREAD_LIST_PAGINATION_OPTS } from "../constants/query-options";

("use client");

/**
 * Hook to get all threads for the current user.
 * Returns paginated threads with app-specific metadata.
 * Automatically waits for Lunora authentication before making queries.
 * Filters threads by the active organization (null = personal space) and optionally by team.
 * @param enabled If false, skips the query regardless of auth state
 */
export const useThreads = (enabled: boolean = true) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const { hooks } = useAuth();
    const { data: activeOrganization, isPending: isOrgPending } = hooks.useActiveOrganization();
    const { data: sessionData, isPending: isSessionPending } = hooks.useSession();

    // Get active team ID from session
    const activeTeamId = (sessionData?.session as { activeTeamId?: string | null })?.activeTeamId ?? undefined;

    // Only run query when authenticated, not loading, and organization state is ready
    const shouldQuery = enabled && isAuthenticated && !isLoading && !isOrgPending && !isSessionPending;

    // Get organizationId: null for personal space, string for organization
    const organizationId = activeOrganization?.id ?? null;

    // Stabilize query options to prevent unnecessary re-subscriptions
    const queryOptions = useMemo(
        () =>
            shouldQuery
                ? {
                      organizationId,
                      paginationOpts: THREAD_LIST_PAGINATION_OPTS,
                      teamId: activeTeamId,
                  }
                : skipToken,
        [shouldQuery, organizationId, activeTeamId],
    );

    // Reduced from 1000 to 100 for better initial load performance
    // Threads are paginated, so we can load more as needed
    // This reduces initial query time and memory usage
    const { data: threads } = useQuery(crpc.chat.functions.getThreads.queryOptions(queryOptions));

    return useMemo(() => threads?.page || [], [threads]);
};

/**
 * Hook to get a single thread by ID.
 * Automatically waits for Lunora authentication before making queries.
 */
export const useThread = (threadId: string | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    // Only run query when authenticated, not loading, and threadId is provided
    const shouldQuery = isAuthenticated && !isLoading && !!threadId;

    const { data } = useQuery(crpc.chat.functions.getThread.queryOptions(shouldQuery ? { threadId: threadId! as Id<"threads"> } : skipToken));

    return data;
};

/**
 * Hook to update a thread.
 * Returns the updateThread action.
 * Note: Actions don't support optimistic updates directly, but queries will update reactively.
 */
export const useUpdateThread = () => {
    const { mutateAsync } = useReactQueryMutation(useLunoraActionOptions(api.chat.functions.updateThread));

    return mutateAsync;
};
