import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

const PAGE_SIZE = 100;

/** One project list (the caller's own, or an organization's), a page at a time. */
const usePagedProjects = (organizationId: string | undefined, enabled: boolean) => {
    const crpc = useCRPC();
    // Cursors belong to one list: another organization starts again from its first page.
    const [paging, setPaging] = useState<{ cursors: ReadonlyArray<string | null>; organizationId: string | undefined }>({ cursors: [null], organizationId });
    const cursors = paging.organizationId === organizationId ? paging.cursors : [null];
    const pages = useQueries({
        // Each loaded page is bounded at the next page's cursor (Lunora's reactive pagination), so a live refresh
        // after a project is added or removed cannot shift a boundary and duplicate or drop a project.
        queries: cursors.map((cursor, index) =>
            crpc.projects.functions.listProjects.queryOptions(
                enabled
                    ? { organizationId, paginationOpts: { cursor, endCursor: cursors[index + 1] ?? undefined, id: undefined, numItems: PAGE_SIZE } }
                    : skipToken,
            ),
        ),
    });
    const last = pages.at(-1);
    const next = last?.data && !last.data.isDone ? last.data.continueCursor : null;

    return {
        failed: last?.isError === true,
        hasMore: next !== null,
        isLoadingMore: enabled && cursors.length > 1 && last?.isPending === true,
        loadMore: () => {
            if (next !== null) {
                setPaging({ cursors: [...cursors, next], organizationId });
            }
        },
        projects: pages.flatMap((page) => page.data?.page ?? []),
        retry: () => {
            void last?.refetch();
        },
    };
};

/**
 * The projects a task can be filed in: the caller's own, and the active organization's projects nobody owns
 * (the ones a member may file into, as `writableProject` decides), each a page at a time. The task's own project
 * is looked up by id when it is not on a loaded page, so an existing assignment always shows its name.
 */
const useTaskProjects = (assignedId: Id<"projects"> | "") => {
    const crpc = useCRPC();
    const { authClient } = useAuth();
    const { data: activeOrganization } = useActiveOrganization(authClient);
    const organizationId = activeOrganization?.id;
    const own = usePagedProjects(undefined, true);
    const shared = usePagedProjects(organizationId, organizationId !== undefined);
    const seen = new Set(own.projects.map((project) => project._id));
    const loaded = [...own.projects, ...shared.projects.filter((project) => !project.userId && !seen.has(project._id))];
    const missing = assignedId !== "" && loaded.every((project) => project._id !== assignedId);
    const { data: assigned } = useQuery(crpc.projects.functions.getProject.queryOptions(missing ? { projectId: assignedId } : skipToken));

    return {
        failed: own.failed || shared.failed,
        hasMore: own.hasMore || shared.hasMore,
        isLoadingMore: own.isLoadingMore || shared.isLoadingMore,
        loadMore: () => {
            own.loadMore();
            shared.loadMore();
        },
        projects: missing && assigned ? [...loaded, assigned] : loaded,
        retry: () => {
            own.retry();
            shared.retry();
        },
    };
};

export default useTaskProjects;
