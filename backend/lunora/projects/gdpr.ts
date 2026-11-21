/**
 * The projects module's own rows for erasure and export: a project's repositories (`projectRepositories`) and its rule
 * files (`projectRuleFiles`). Both go with their project when it is deleted, and by their owner's `userId` when the
 * owner's account is, which also reaches a row a failed project delete left behind. The repository rows of an
 * organization project nobody owns carry no `userId`: they go when the organization is deleted
 * (`eraseOrganizationRepositories`, queued from `auth.ts`, with a daily sweep behind it).
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
import { vSubAgentRoles } from "../sub-agents/validators";
import { PROJECTS_PER_DETAILS_READ, PROJECTS_PER_RULE_FILES_READ } from "./export-pages";
import { DELETION_MARKER_TTL_MS, DELETION_MARKER_URL, isRepoRow } from "./repositories";
import { findProjectRowsMeasured, projectRowsReadBytes } from "./project-row";

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
const ruleFileLogger = logger.scope("project-rule-files");

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
        // Only while the row still holds the copy read here: a move that stamped it meanwhile wins.
        await ctx.db.patchIf("projectRepositories", row._id, {
            patch: { organizationId: project.organizationId ?? "" },
            where: { organizationId: row.organizationId ?? null, projectId: row.projectId },
        });

        return false;
    }

    await ctx.db.delete("projectRepositories", row._id);

    return true;
};

/**
 * Re-stamps a row whose copy of its project's organization went stale (a move whose re-stamp and queued retries all
 * lost to later moves, or whose retry could not be queued). The project is read from the primary, once per project.
 * Only while the row still holds the copy read here, so a move landing meanwhile wins. Returns whether it re-stamped.
 */
const restampIfMoved = async (ctx: MutationCtx, row: Doc<"projectRepositories">, projects: Map<string, Promise<Doc<"projects"> | null>>): Promise<boolean> => {
    if (!projects.has(row.projectId)) {
        projects.set(row.projectId, ctx.db.projects.findFirst({ consistency: "primary", where: { _id: row.projectId } }));
    }

    let project: Doc<"projects"> | null | undefined;

    try {
        project = await projects.get(row.projectId);
    } catch (error) {
        repoLogger.error("Reading a project during the repository sweep failed; its row is left as it is", { error, projectId: row.projectId });

        return false;
    }

    const organizationId = project?.organizationId ?? "";

    if (!project || organizationId === (row.organizationId ?? "")) {
        return false;
    }

    const { applied } = await ctx.db.patchIf("projectRepositories", row._id, {
        patch: { organizationId },
        where: { organizationId: row.organizationId ?? null, projectId: row.projectId },
    });

    return applied;
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
 * An organization that cannot be read is kept, so a failed read never deletes rows. Every other row whose project has
 * moved since its copy of the organization was written is re-stamped (`restampIfMoved`), so a move the re-stamp and its
 * queued retries left unsettled is repaired within a day.
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
        let restamped = 0;

        for (const row of page.page) {
            if (!isOrganizationOwned(row)) {
                if (await restampIfMoved(ctx, row, projects)) {
                    restamped += 1;
                }

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

            if (gone.get(organizationId)) {
                if (await eraseUnlessMoved(ctx, row, projects)) {
                    deleted += 1;
                }
            } else if (await restampIfMoved(ctx, row, projects)) {
                restamped += 1;
            }
        }

        if (deleted > 0) {
            repoLogger.info("Removed repository rows of deleted organizations", { deleted });
        }

        if (restamped > 0) {
            repoLogger.info("Re-stamped repository rows of projects that moved", { restamped });
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
            .filter((row) => isRepoRow(row))
            .map(({ createdAt, defaultAt, defaultBranch, projectId, url }) => {
                return { createdAt, projectId, url, ...(defaultAt !== undefined && { defaultAt }), ...(defaultBranch && { defaultBranch }) };
            });

        return { cursor: result.isDone ? null : result.continueCursor, projectRepositories };
    });

/**
 * Projects' details for the export, next to their repositories, in one read: each one's title and whether it is shared
 * (`isPublic`), never the share token (`pages/gdpr.ts` drops a page's the same way). `readBytes` is what reading the
 * whole rows cost, `context` and workflow included ({@link findProjectRowsMeasured}), so the export can count it against
 * its read budget. A project that is gone or not the user's is left out.
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
        const { page, readBytes } = await findProjectRowsMeasured(ctx.db.projects, { consistency: "primary", where: { _id: { in: projectIds } } });
        const projects = page
            .filter((row) => row.userId === userId)
            .map((row) => {
                // Shared while it is public: unpublishing keeps the token (so a re-publish keeps its link) but clears `isPublic`.
                return { project: { sharingEnabled: row.isPublic === true, title: row.title }, projectId: row._id };
            });

        return { projects, readBytes };
    });

/**
 * One page of the user's projects for the export, the ones without a repository too (`collectAllOwnedProjects`), with what
 * reading it cost: the whole rows, heavy columns included ({@link findProjectRowsMeasured}), though only the exported
 * ones are returned. A page holds {@link PROJECTS_PER_DETAILS_READ} rows.
 * Each project carries the machine and folder a computer's project records, which only its owner may see.
 */
export const collectOwnedProjectsForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            projects: v.array(
                v.object({
                    // Its legacy context, for the rule files' pass (`attachProjectRuleFiles`), read while the project was
                    // the user's; never exported as a project's own field.
                    context: v.optional(v.string()),
                    machineId: v.optional(v.string()),
                    path: v.optional(v.string()),
                    projectId: v.string(),
                    sharingEnabled: v.boolean(),
                    subAgentRoles: v.optional(vSubAgentRoles),
                    title: v.string(),
                }),
            ),
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const result = await findProjectRowsMeasured(ctx.db.projects, {
            consistency: "primary",
            cursor: cursor ?? null,
            limit: PROJECTS_PER_DETAILS_READ,
            orderBy: [{ _creationTime: "asc" }],
            where: { userId },
        });
        const { readBytes } = result;
        const projects = result.page.map((row) => {
            return {
                ...(row.context && { context: row.context }),
                ...(row.machineId !== undefined && { machineId: row.machineId }),
                ...(row.path !== undefined && { path: row.path }),
                projectId: row._id,
                sharingEnabled: row.isPublic === true,
                ...(row.subAgentRoles !== undefined && { subAgentRoles: row.subAgentRoles }),
                title: row.title,
            };
        });

        return { cursor: result.isDone ? null : result.continueCursor, projects, readBytes };
    });

/**
 * The saved rule-file rows of up to {@link PROJECTS_PER_RULE_FILES_READ} of `userId`'s projects for the export, and what
 * reading them cost, each row whole. Access follows the project, never the rule-file row's `userId` (a copy for
 * erasure): the projects' page (`collectOwnedProjectsForExport`) gave these ids, but a project can change owner (an
 * account merge, an organization move) before this read, so the project rows are read again here, in the same query,
 * and only the ones still `userId`'s have their rule files read. Both reads are counted. Their legacy `context` still
 * comes from that page; `attachProjectRuleFiles` puts the two together.
 * A separate read from the projects' page, so the export can leave them out past its budget and keep the rest.
 */
export const collectProjectRuleFilesForExport = internalQuery
    .input({ projectIds: v.array(v.id("projects")).max(PROJECTS_PER_RULE_FILES_READ), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            projects: v.array(
                v.object({
                    carriedContext: v.optional(v.string()),
                    files: v.array(
                        v.object({
                            content: v.string(),
                            description: v.optional(v.string()),
                            globs: v.optional(v.array(v.string())),
                            id: v.string(),
                            mode: v.union(v.literal("always"), v.literal("auto"), v.literal("glob")),
                            title: v.string(),
                        }),
                    ),
                    projectId: v.string(),
                }),
            ),
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { projectIds, userId }, ctx }) => {
        if (projectIds.length === 0) {
            return { projects: [], readBytes: 0 };
        }

        // Owned now, not only when the page was read: a project moved since gives its new owner's rules to no one else.
        const owners = await findProjectRowsMeasured(ctx.db.projects, { consistency: "primary", where: { _id: { in: projectIds } } });
        const owned = owners.page.filter((row) => row.userId === userId).map((row) => row._id);
        const { page: rows } =
            owned.length > 0 ? await ctx.db.projectRuleFiles.findMany({ consistency: "primary", where: { projectId: { in: owned } } }) : { page: [] };
        const projects = rows.map((row) => {
            return { ...(row.carriedContext && { carriedContext: row.carriedContext }), files: row.files, projectId: row.projectId as string };
        });

        return { projects, readBytes: owners.readBytes + projectRowsReadBytes(rows) };
    });

/**
 * The rule files of `projectId`, once the project row is gone: `agent.projects.deleteProject` (account deletion pages
 * through {@link eraseProjectsRuleFiles}), so a save that landed before it leaves nothing, and one after it finds
 * no project and erases its own (`setProjectRuleFiles`). Also that save's own take-back.
 */
export const eraseProjectRuleFiles = async (ctx: MutationCtx, projectId: Id<"projects">): Promise<void> => {
    const row = await ctx.db.projectRuleFiles.findFirst({ consistency: "primary", where: { projectId } });

    if (row) {
        await ctx.db.delete("projectRuleFiles", row._id);
    }
};

/**
 * Marks the rule files of a project whose delete is about to remove the project row (`agent.projects.deleteProject`):
 * they go only after the row, so a delete failing in between leaves a live project with its rules, and one failing
 * after leaves a marked row that {@link sweepUnfinishedRuleFileErasures} finishes.
 */
export const markProjectRuleFilesErasing = async (ctx: MutationCtx, projectId: Id<"projects">): Promise<void> => {
    const row = await ctx.db.projectRuleFiles.findFirst({ consistency: "primary", where: { projectId } });

    if (row) {
        await ctx.db.patch("projectRuleFiles", row._id, { deletingAt: ctx.now });
    }
};

/**
 * Rule-file rows one erasure or sweep reads at most: each is charged whole, up to `MAX_RULE_FILES_BYTES`, so a page
 * stays far under a transaction's read limit. Also the projects one account-deletion page erases, one row each at most.
 */
export const RULE_FILE_ROWS_PER_PAGE = 8;

/**
 * Marks the rule files of a page of projects (at most {@link RULE_FILE_ROWS_PER_PAGE}) in one read, as
 * {@link markProjectRuleFilesErasing} does one: account deletion's `agent/gdpr.ts#eraseProjectsForUser`.
 */
export const markProjectsRuleFilesErasing = async (ctx: MutationCtx, projectIds: ReadonlyArray<Id<"projects">>): Promise<void> => {
    if (projectIds.length === 0) {
        return;
    }

    const { page: rows } = await ctx.db.projectRuleFiles.findMany({ consistency: "primary", where: { projectId: { in: [...projectIds] } } });

    await Promise.all(rows.map((row) => ctx.db.patch("projectRuleFiles", row._id, { deletingAt: ctx.now })));
};

/** Erases the rule files of a page of projects whose rows are gone in one read, as {@link eraseProjectRuleFiles} does one. */
export const eraseProjectsRuleFiles = async (ctx: MutationCtx, projectIds: ReadonlyArray<Id<"projects">>): Promise<void> => {
    if (projectIds.length === 0) {
        return;
    }

    const { page: rows } = await ctx.db.projectRuleFiles.findMany({ consistency: "primary", where: { projectId: { in: [...projectIds] } } });

    await Promise.all(rows.map((row) => ctx.db.delete("projectRuleFiles", row._id)));
};

/**
 * The rule-file rows of the user's projects by their copy of the owner (`userId`), one page: a row whose project is
 * already gone too, one a failed project delete left.
 */
export const eraseProjectRuleFilesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: rows } = await ctx.db.projectRuleFiles.findMany({ consistency: "primary", limit: RULE_FILE_ROWS_PER_PAGE, where: { userId } });

    await Promise.all(rows.map((row) => ctx.db.delete("projectRuleFiles", row._id)));

    return { hasMore: rows.length >= RULE_FILE_ROWS_PER_PAGE };
};

/**
 * Daily backstop for a project delete that failed after the project row went (`markProjectRuleFilesErasing`): a row
 * marked longer than a delete can take is erased once its project is gone, and unmarked while it is there (a delete
 * that failed before). A project that cannot be read keeps its row. One page per run; the next is scheduled.
 */
export const sweepUnfinishedRuleFileErasures = internalMutation
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const page = await ctx.db.projectRuleFiles.findMany({
            consistency: "primary",
            cursor: args.cursor ?? null,
            limit: RULE_FILE_ROWS_PER_PAGE,
            where: { deletingAt: { gt: 0, lt: ctx.now - DELETION_MARKER_TTL_MS } },
        });
        let erased = 0;

        for (const row of page.page) {
            let project: Doc<"projects"> | null;

            try {
                project = await ctx.db.projects.findFirst({ consistency: "primary", where: { _id: row.projectId } });
            } catch (error) {
                ruleFileLogger.error("Reading a project during the rule-file sweep failed; its rule files are kept", { error, projectId: row.projectId });

                continue;
            }

            if (project) {
                await ctx.db.patchIf("projectRuleFiles", row._id, { patch: { deletingAt: 0 }, where: { deletingAt: row.deletingAt ?? null } });
            } else {
                await ctx.db.delete("projectRuleFiles", row._id);
                erased += 1;
            }
        }

        if (erased > 0) {
            ruleFileLogger.info("Erased the rule files of deleted projects", { erased });
        }

        if (!page.isDone && page.continueCursor) {
            await ctx.scheduler.runAfter(0, internal.projects.gdpr.sweepUnfinishedRuleFileErasures, { cursor: page.continueCursor });
        }

        return null;
    });
