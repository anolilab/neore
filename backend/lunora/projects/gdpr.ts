/**
 * The projects module's own rows for erasure and export: a project's repositories (`projectRepositories`). They go with
 * their project when it is deleted, and by their owner's `userId` when the owner's account is, which also reaches a row
 * a failed project delete left behind. The rows of an organization project nobody owns carry no `userId`: they go when
 * the organization is deleted (`eraseOrganizationRepositories`, queued from `auth.ts`, with a daily sweep behind it).
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";
import { MAX_LENGTH } from "../lib/validators";
import { PROJECTS_PER_DETAILS_READ } from "./export-pages";
import { DELETION_MARKER_URL } from "./repositories";

/** A project's repositories, one batch; with `keepMarker`, a delete's marker stays until the delete is done. */
export const eraseProjectRepositories = async (ctx: MutationCtx, projectId: Id<"projects">, { keepMarker = false } = {}): Promise<BatchResult> => {
    // From the primary, as every erasure read here: a lagging replica's empty page would end the erasure with rows left.
    const { page: rows } = await ctx.db.projectRepositories.findMany({ consistency: "primary", limit: BATCH, where: { projectId } });
    const erased = keepMarker ? rows.filter((row) => row.url !== DELETION_MARKER_URL) : rows;

    await Promise.all(erased.map((row) => ctx.db.delete("projectRepositories", row._id)));

    return { hasMore: full(rows) };
};

/** Every repository row of the user's projects, one batch, whether or not the project still exists. */
export const eraseProjectRepositoriesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: rows } = await ctx.db.projectRepositories.findMany({ consistency: "primary", limit: BATCH, where: { userId } });

    await Promise.all(rows.map((row) => ctx.db.delete("projectRepositories", row._id)));

    return { hasMore: full(rows) };
};

const repoLogger = logger.scope("project-repositories");

/** Whether a row belongs to an organization project nobody owns: the organization's data, not a person's. */
const isOrganizationOwned = (row: { organizationId?: string; userId?: string }): boolean => row.userId === undefined && !!row.organizationId;

/**
 * Erases an organization-owned row of a deleted organization, unless its project has moved to another organization: a
 * move commits the project before it re-stamps the rows, and a re-stamp that failed is never retried. Such a row is
 * re-stamped here instead. The project is read from the primary, once per project (`projects`). Returns whether it erased.
 */
const eraseUnlessMoved = async (
    ctx: MutationCtx,
    row: Doc<"projectRepositories">,
    projects: Map<string, Promise<Doc<"projects"> | null>>,
): Promise<boolean> => {
    if (!projects.has(row.projectId)) {
        projects.set(row.projectId, ctx.db.projects.findFirst({ consistency: "primary", where: { _id: row.projectId } }));
    }

    let project: Doc<"projects"> | null | undefined;

    try {
        project = await projects.get(row.projectId);
    } catch (error) {
        // As for an organization that cannot be read: a failed read never deletes rows.
        repoLogger.error("Reading a project during an organization's repository erase failed; its row is kept", { error, projectId: row.projectId });

        return false;
    }

    if (project && (project.organizationId ?? "") !== row.organizationId) {
        await ctx.db.patch("projectRepositories", row._id, { organizationId: project.organizationId ?? "" });

        return false;
    }

    await ctx.db.delete("projectRepositories", row._id);

    return true;
};

/**
 * A deleted organization's repository rows: those of its projects nobody owns. A project someone owns keeps its rows;
 * they go with the owner's account. One page per run, by cursor, so rows kept do not stop it; the next page is scheduled.
 */
export const eraseOrganizationRepositories = internalMutation
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)), organizationId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { cursor, organizationId }, ctx }) => {
        // From the primary: a replica's stale copy could still show a row under this organization after its project moved.
        const page = await ctx.db.projectRepositories.findMany({ consistency: "primary", cursor: cursor ?? null, limit: BATCH, where: { organizationId } });

        const projects = new Map<string, Promise<Doc<"projects"> | null>>();

        await Promise.all(page.page.filter((row) => isOrganizationOwned(row)).map(async (row) => await eraseUnlessMoved(ctx, row, projects)));

        if (!page.isDone && page.continueCursor) {
            await ctx.scheduler.runAfter(0, internal.projects.gdpr.eraseOrganizationRepositories, { cursor: page.continueCursor, organizationId });
        }

        return null;
    });

/** Queue the removal of a deleted organization's repository rows. Never throws: the daily sweep is the backstop. */
export const queueOrganizationRepoErase = async (organizationId: string): Promise<void> => {
    try {
        await enqueueJob(internal.projects.gdpr.eraseOrganizationRepositories, { organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        repoLogger.error("Queueing a deleted organization's repository removal failed", { error, organizationId });
    }
};

/** Repository rows one sweep run looks at; a run that did not reach the end schedules the next page itself. */
const ORPHAN_SWEEP_PAGE_SIZE = 100;

/**
 * Daily backstop for `eraseOrganizationRepositories`: the organization-owned rows whose organization no longer exists.
 * An organization that cannot be read is kept, so a failed read never deletes rows.
 */
export const sweepOrphanedOrganizationRepositories = internalMutation
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // From the primary, like the organization read below: no stale `organizationId` decides a delete.
        const page = await ctx.db.projectRepositories.findMany({ consistency: "primary", cursor: args.cursor ?? null, limit: ORPHAN_SWEEP_PAGE_SIZE });
        const gone = new Map<string, boolean>();
        const projects = new Map<string, Promise<Doc<"projects"> | null>>();
        let deleted = 0;

        for (const row of page.page) {
            if (!isOrganizationOwned(row)) {
                continue;
            }

            const organizationId = row.organizationId as string;

            if (!gone.has(organizationId)) {
                try {
                    // From the primary: a lagging replica that has not seen a new organization yet must not read as "deleted".
                    const organization = await ctx.db.organization.findFirst({
                        consistency: "primary",
                        where: { _id: ctx.db.asId("organization", organizationId) },
                    });

                    gone.set(organizationId, organization === null);
                } catch (error) {
                    repoLogger.error("Reading an organization during the repository sweep failed; its rows are kept", { error, organizationId });
                    gone.set(organizationId, false);
                }
            }

            if (gone.get(organizationId) && (await eraseUnlessMoved(ctx, row, projects))) {
                deleted += 1;
            }
        }

        if (deleted > 0) {
            repoLogger.info("Removed repository rows of deleted organizations", { deleted });
        }

        if (!page.isDone && page.continueCursor) {
            await ctx.scheduler.runAfter(0, internal.projects.gdpr.sweepOrphanedOrganizationRepositories, { cursor: page.continueCursor });
        }

        return null;
    });

/** Repository rows per export page. */
const REPOSITORY_EXPORT_PAGE = 100;

/** The user's repository rows for the export, by owner, so one whose project is gone is exported too; never a marker. */
export const collectProjectRepositoriesForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ cursor: v.union(v.string(), v.null()), projectRepositories: v.array(v.any()) }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const result = await ctx.db.projectRepositories.findMany({
            cursor: cursor ?? null,
            limit: REPOSITORY_EXPORT_PAGE,
            orderBy: [{ _creationTime: "asc" }],
            where: { userId },
        });
        const projectRepositories = result.page
            .filter((row) => row.deletingAt === undefined)
            .map(({ createdAt, defaultAt, defaultBranch, projectId, url }) => {
                return { createdAt, projectId, url, ...(defaultAt !== undefined && { defaultAt }), ...(defaultBranch && { defaultBranch }) };
            });

        return { cursor: result.isDone ? null : result.continueCursor, projectRepositories };
    });

/**
 * Projects' details for the export, next to their repositories, in one read: each one's title and whether it is shared
 * (`isPublic`), never the share token (`pages/gdpr.ts` drops a page's the same way). `readBytes` is what reading the
 * whole rows cost, `context` and workflow included, so the export can count it against its read budget. A project
 * that is gone or not the user's is left out.
 */
export const collectProjectDetailsForExport = internalQuery
    .input({ projectIds: v.array(v.id("projects")).max(PROJECTS_PER_DETAILS_READ), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            projects: v.array(v.object({ project: v.object({ sharingEnabled: v.boolean(), title: v.string() }), projectId: v.string() })),
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { projectIds, userId }, ctx }) => {
        const { page } = await ctx.db.projects.findMany({ where: { _id: { in: projectIds } } });
        const readBytes = page.reduce((total, row) => total + new TextEncoder().encode(JSON.stringify(row)).byteLength, 0);
        const projects = page
            .filter((row) => row.userId === userId)
            .map((row) => {
                // Shared while it is public: unpublishing keeps the token (so a re-publish keeps its link) but clears `isPublic`.
                return { project: { sharingEnabled: row.isPublic === true, title: row.title }, projectId: row._id };
            });

        return { projects, readBytes };
    });
