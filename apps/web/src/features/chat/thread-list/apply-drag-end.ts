import { arrayMove } from "@dnd-kit/sortable";
import type { Id } from "@neore/backend/dataModel";

import type { ThreadGroup } from "./types";

type DragItem = {
    data?: { current?: { projectId?: string; type?: string } | null };
    id: number | string;
};

export type DragEndMutations = {
    moveThreadToProject: (arguments_: { projectId: Id<"projects"> | undefined; threadId: Id<"threads"> }) => Promise<unknown>;
    updateProjectOrder: (arguments_: { projectOrders: { order: number; projectId: string }[] }) => Promise<unknown>;
    updateThreadOrder: (arguments_: { threadOrders: { order: number; threadId: string }[] }) => Promise<unknown>;
};

/**
 * Saves what a drop in the thread list means: a project group reordered, a thread moved into, out of or between
 * projects, or threads reordered within a group. Throws when a save fails.
 *
 * Kept out of the list component: the React Compiler cannot lower the conditionals of a `try` body, and the component
 * calls this inside one.
 */
const applyDragEnd = async (active: DragItem, over: DragItem, threadGroups: ThreadGroup[], mutations: DragEndMutations): Promise<void> => {
    const { moveThreadToProject, updateProjectOrder, updateThreadOrder } = mutations;
    // Check if we're reordering project groups
    const activeId = active.id as string;
    const isProjectGroupDrag = activeId.startsWith("project-group-");

    // If dragging a project group, only handle project group reordering
    // Don't fall through to thread handling
    if (isProjectGroupDrag) {
        const activeProjectId = activeId.replace("project-group-", "");
        const overId = over.id as string;

        // Check if dropping on another project group (could be project-group-{id} or project-{id})
        let overProjectId: string | undefined;

        if (overId.startsWith("project-group-")) {
            overProjectId = overId.replace("project-group-", "");
        } else if (overId.startsWith("project-") && !overId.startsWith("project-group-")) {
            // Dropping on ProjectGroupContainer (but not a project-group- ID)
            overProjectId = overId.replace("project-", "");
        } else if (over.data?.current?.type === "project-container" && over.data.current.projectId) {
            // Dropping on project container via data
            overProjectId = over.data.current.projectId;
        }

        // Only reorder if we found a valid target project and it's different from the source
        if (overProjectId && overProjectId !== activeProjectId) {
            // Find project groups in threadGroups (maintain current order from threadGroups)
            const projectGroups = threadGroups.filter((g) => g.projectId);
            const activeIndex = projectGroups.findIndex((g) => g.projectId === activeProjectId);
            const overIndex = projectGroups.findIndex((g) => g.projectId === overProjectId);

            if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
                const reorderedProjects = arrayMove(projectGroups, activeIndex, overIndex);

                // Update project orders
                const projectOrders = reorderedProjects.map((group, index) => {
                    return {
                        order: index,
                        projectId: group.projectId!,
                    };
                });

                await updateProjectOrder({
                    projectOrders,
                });
            }
        }

        // Always return early for project group drags - don't handle as thread
        return;
    }

    // Only handle thread drags from here on
    const threadId = active.id as Id<"threads">;

    // Ensure we're not accidentally treating a project group ID as a thread ID
    if (threadId.startsWith("project-group-")) {
        return;
    }

    // First, check if we're dropping on a project container (highest priority)
    // Check both the ID and the data type to ensure we catch project container drops
    const isProjectContainerDrop = (typeof over.id === "string" && over.id.startsWith("project-")) || over.data?.current?.type === "project-container";

    if (isProjectContainerDrop) {
        let targetProjectId: string | undefined;

        if (typeof over.id === "string" && over.id.startsWith("project-")) {
            targetProjectId = over.id.replace("project-", "");
        } else if (over.data?.current?.projectId) {
            targetProjectId = over.data.current.projectId;
        }

        // Find which project the thread currently belongs to
        let currentProjectId: string | undefined;

        for (const group of threadGroups) {
            if (group.threads.some((candidate) => candidate.threadId === threadId)) {
                currentProjectId = group.projectId;
                break;
            }
        }

        // Only move if it's a different project
        if (currentProjectId !== targetProjectId) {
            await moveThreadToProject({
                projectId: (targetProjectId || undefined) as Id<"projects"> | undefined,
                threadId,
            });
        }

        return;
    }

    // Find which group the active and over items belong to
    let activeGroup: ThreadGroup | null = null;
    let overGroup: ThreadGroup | null = null;
    let activeIndex = -1;
    let overIndex = -1;

    for (const group of threadGroups) {
        const activeThreadIndex = group.threads.findIndex((candidate) => candidate.threadId === active.id);
        const overThreadIndex = group.threads.findIndex((candidate) => candidate.threadId === over.id);

        if (activeThreadIndex !== -1) {
            activeGroup = group;
            activeIndex = activeThreadIndex;
        }

        if (overThreadIndex !== -1) {
            overGroup = group;
            overIndex = overThreadIndex;
        }
    }

    // If we couldn't find the groups, check if over.id is a thread ID that belongs to a project
    // This handles the case where we drop on a thread inside a project container
    if (!overGroup && typeof over.id === "string") {
        for (const group of threadGroups) {
            if (group.threads.some((candidate) => candidate.threadId === over.id)) {
                overGroup = group;
                overIndex = group.threads.findIndex((candidate) => candidate.threadId === over.id);
                break;
            }
        }
    }

    // Check if we're moving between different groups (including project groups)
    if (activeGroup && overGroup && activeGroup !== overGroup) {
        // If moving from one project to another, use project move
        if (activeGroup.projectId && overGroup.projectId && activeGroup.projectId !== overGroup.projectId) {
            await moveThreadToProject({
                projectId: overGroup.projectId as Id<"projects">,
                threadId,
            });

            return;
        }

        // If moving from project to non-project group, remove from project
        if (activeGroup.projectId && !overGroup.projectId) {
            await moveThreadToProject({
                projectId: undefined,
                threadId,
            });

            return;
        }

        // If moving from non-project to project group, add to project
        if (!activeGroup.projectId && overGroup.projectId) {
            await moveThreadToProject({
                projectId: overGroup.projectId as Id<"projects">,
                threadId,
            });
        }

        // If moving between any different groups (not same group), don't reorder
        return;
    }

    // Only allow reordering within the same group
    if (!activeGroup || !overGroup || activeGroup.title !== overGroup.title) {
        return;
    }

    // Reorder threads within the group
    const reorderedThreads = arrayMove(activeGroup.threads, activeIndex, overIndex);

    // Update the order in the database
    const threadOrders = reorderedThreads.map((thread, index) => {
        return {
            order: index,
            threadId: thread.threadId,
        };
    });

    await updateThreadOrder({
        threadOrders,
    });
};

export default applyDragEnd;
