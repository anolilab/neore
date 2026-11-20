/**
 * Where a paired device may be used: `projectIds` unset means any of the owner's chats, a list means only
 * threads of those projects (an empty list: nowhere). Checked where the tool set is built and again when a call
 * is created, both through {@link isDeviceInScope}.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** The thread's project is the one that counts, and a thread without one is outside every project scope. */
export const isDeviceInScope = (device: Pick<Doc<"devices">, "projectIds">, threadProjectId: Id<"projects"> | undefined): boolean =>
    device.projectIds === undefined || (threadProjectId !== undefined && device.projectIds.includes(threadProjectId));

/** D1 caps bound parameters per statement at 100; each read leaves room for `userId` and the query's own. */
const IDS_PER_READ = 90;

/** Which of `ids` are projects of `userId` that still exist: a few reads through the `.global()` facade, in batches D1 accepts. */
export const filterOwnProjectIds = async (ctx: Pick<QueryCtx, "db">, userId: string, ids: Iterable<Id<"projects">>): Promise<Set<Id<"projects">>> => {
    const unique = [...new Set(ids)];
    const batches: Id<"projects">[][] = [];

    for (let start = 0; start < unique.length; start += IDS_PER_READ) {
        batches.push(unique.slice(start, start + IDS_PER_READ));
    }

    const pages = await Promise.all(batches.map(async (batch) => await ctx.db.projects.findMany({ where: { _id: { in: batch }, userId } })));

    return new Set(pages.flatMap(({ page }) => page.map((project) => project._id)));
};

/**
 * The project a thread belongs to NOW: a project that was deleted, or is not the owner's, reads as none, so a
 * thread still naming one cannot match a stale entry of a device's list. Skips the read when no device is scoped.
 */
export const resolveThreadProject = async (
    ctx: Pick<QueryCtx, "db">,
    thread: Pick<Doc<"threads">, "projectId">,
    userId: string,
    devices: ReadonlyArray<Pick<Doc<"devices">, "projectIds">>,
): Promise<Id<"projects"> | undefined> => {
    if (thread.projectId === undefined || devices.every((device) => device.projectIds === undefined)) {
        return undefined;
    }

    const project = await ctx.db.projects.findFirst({ where: { _id: thread.projectId, userId } });

    return project?._id;
};
