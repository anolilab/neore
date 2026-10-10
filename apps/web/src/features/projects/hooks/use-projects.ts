import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

("use client");

/**
 * `endCursor`/`id` are `v.optional(...)` inside a `v.object`, but codegen emits
 * them as required keys with an `| undefined` value, so they must be spelled out.
 */
const PROJECT_LIST_PAGINATION_OPTS = {
    cursor: null,
    endCursor: undefined,
    id: undefined,
    numItems: 100,
} as const;

/**
 * Hook to get all projects for the current user.
 * Returns paginated projects.
 * Automatically waits for Lunora authentication before making queries.
 * @param enabled If false, skips the query regardless of auth state
 */
export const useProjects = (enabled: boolean = true) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    // Only run query when authenticated and not loading
    const shouldQuery = enabled && isAuthenticated && !isLoading;

    const { data: projects } = useQuery(
        crpc.projects.functions.listProjects.queryOptions(shouldQuery ? { paginationOpts: PROJECT_LIST_PAGINATION_OPTS } : skipToken),
    );

    // Memoize to ensure stable reference and consistency with useThreads pattern
    return useMemo(() => projects?.page ?? [], [projects]);
};

/**
 * Hook to get pinned projects for the current user.
 * Automatically waits for Lunora authentication before making queries.
 */
export const usePinnedProjects = (enabled: boolean = true) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    // Only run query when authenticated and not loading
    const shouldQuery = enabled && isAuthenticated && !isLoading;

    const { data } = useQuery(crpc.projects.functions.listPinnedProjects.queryOptions(shouldQuery ? {} : skipToken));

    return data;
};

/**
 * Hook to get a single project by ID.
 * Automatically waits for Lunora authentication before making queries.
 */
export const useProject = (projectId: Id<"projects"> | undefined) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    // Only run query when authenticated, not loading, and projectId is provided
    const shouldQuery = isAuthenticated && !isLoading && !!projectId;

    const { data } = useQuery(crpc.projects.functions.getProject.queryOptions(shouldQuery ? { projectId: projectId! } : skipToken));

    return data;
};

/**
 * Hook to create a new project.
 */
export const useCreateProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.createProject.mutationOptions());
};

/**
 * Hook to update a project.
 */
export const useUpdateProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.updateProject.mutationOptions());
};

/**
 * Hook to delete a project.
 */
export const useDeleteProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.deleteProject.mutationOptions());
};

/**
 * Hook to pin/unpin a project.
 */
export const usePinProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.pinProject.mutationOptions());
};

export const useUnpinProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.unpinProject.mutationOptions());
};

/**
 * Hook to move a thread to a project.
 */
export const useMoveThreadToProject = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.moveThreadToProject.mutationOptions());
};

/**
 * Hook to update project order.
 */
export const useUpdateProjectOrder = () => {
    const crpc = useCRPC();

    return useMutation(crpc.projects.functions.updateProjectOrder.mutationOptions());
};
