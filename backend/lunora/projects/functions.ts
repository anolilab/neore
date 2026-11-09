import { LunoraError, v } from "lunorash/server";

import { listPinnedProjectsHandler, listProjectsHandler } from "../agent/projects";
import { vProjectDocFields } from "../agent/validators";
import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { requireOwnedThread } from "../agent/thread-read-access";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import { authMutation, authQuery, internalQuery, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { admitOrganization, systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { eraseProjectRepositories } from "./gdpr";
import {
    DELETION_MARKER_TTL_MS,
    DELETION_MARKER_URL,
    MAX_PROJECT_REPOSITORIES,
    normalizeBranch,
    normalizeRepoUrl,
    ProjectRepoError,
    withDefault,
} from "./repositories";

/** Whether `userId` is a current member of an organization. */
type MembershipCheck = (organizationId: string) => Promise<boolean>;

/**
 * The one rule for who may read a project: its owner, or a CURRENT member of its organization. A project without an owner
 * is no exception. Every lookup below decides through this.
 */
const mayReadProject = async (project: Pick<Doc<"projects">, "organizationId" | "userId">, userId: string, isMember: MembershipCheck): Promise<boolean> =>
    project.userId === userId || (Boolean(project.organizationId) && (await isMember(project.organizationId!)));

/** The project when the caller owns it or belongs to its organization, else `null` (also for a missing one). */
export const readableProject = async (context: QueryCtx | MutationCtx, projectId: Id<"projects">, userId: string): Promise<Doc<"projects"> | null> => {
    // Decide on the row's owner and organization past RLS: a project of a member's
    // NON-active organization is invisible to the guarded `ctx.db` until the org is admitted.
    const found = await systemDb(context).projects.findFirst({ where: { _id: projectId } });

    const isMember: MembershipCheck = async (organizationId) => (await getMemberByOrganizationAndUser(context, organizationId, userId)) !== null;

    if (!found || !(await mayReadProject(found, userId, isMember))) {
        return null;
    }

    // A proven membership: the project passes row-level security.
    if (found.userId !== userId) {
        admitOrganization(context, found.organizationId!);
    }

    return await context.db.projects.findFirst({ where: { _id: projectId } });
};

/** Ids one `in` read binds: D1 takes at most 100 parameters a statement, and the read binds others beside them. */
const IDS_PER_READ = 90;

/** `ids` in runs of {@link IDS_PER_READ}. */
const inBatches = <T>(ids: ReadonlyArray<T>): T[][] => {
    const batches: T[][] = [];

    for (let index = 0; index < ids.length; index += IDS_PER_READ) {
        batches.push(ids.slice(index, index + IDS_PER_READ));
    }

    return batches;
};

/**
 * The titles of the projects in `projectIds` that `userId` can read, by id: the rule of {@link readableProject} for many
 * projects in a few reads, the rows and then the caller's memberships in their organizations, each in batches of
 * {@link IDS_PER_READ} ids. A project the caller cannot
 * read, or that no longer exists, is left out. For a view that only names projects: no row-level-security re-read, as
 * only titles leave here.
 */
export const readableProjectTitles = async (
    context: QueryCtx | MutationCtx,
    projectIds: ReadonlyArray<Id<"projects">>,
    userId: string,
): Promise<Map<string, string>> => {
    if (projectIds.length === 0) {
        return new Map();
    }

    const rows = [];

    for (const ids of inBatches(projectIds)) {
        const { page } = await systemDb(context).projects.findMany({ where: { _id: { in: ids } } });

        rows.push(...page);
    }

    const organizations = [...new Set(rows.filter((row) => row.userId !== userId && row.organizationId).map((row) => row.organizationId!))];
    const memberOf = new Set<string>();

    for (const ids of inBatches(organizations)) {
        const { page } = await context.db.member.findMany({ where: { organizationId: { in: ids }, userId } });

        for (const membership of page) {
            memberOf.add(membership.organizationId);
        }
    }

    const titles = new Map<string, string>();

    for (const row of rows) {
        if (await mayReadProject(row, userId, async (organizationId) => memberOf.has(organizationId))) {
            titles.set(row._id, row.title);
        }
    }

    return titles;
};

/**
 * The project when `userId` may file threads in it, else `null`: readable (owner or a current member of its
 * organization) AND owned by `userId` or by nobody. The same rule as moving a thread into a project
 * (`moveThreadToProject` here) and updating one: a member never files into another member's project.
 */
export const writableProject = async (context: QueryCtx | MutationCtx, projectId: Id<"projects">, userId: string): Promise<Doc<"projects"> | null> => {
    const project = await readableProject(context, projectId, userId);

    return project && (!project.userId || project.userId === userId) ? project : null;
};

/** A project's `context` text for a run on behalf of `userId`, under the same access rule as `createThread` (owner or organization member). */
export const getProjectContextForRun = internalQuery
    .input({ projectId: v.id("projects"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { projectId, userId }, ctx: context }) => {
        const project = await readableProject(context, projectId, userId);

        return project?.context ?? null;
    });

export const getProject = authQuery
    .input({
        projectId: v.id("projects"),
    })
    .query(async ({ args: { projectId }, ctx: context }) => await readableProject(context, projectId as Id<"projects">, context.user.userId));

export const listProjects = authQuery
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
    })
    // Written out, not `vPaginationResult(...)`: codegen cannot read a call, and
    // an output it cannot read is emitted as an empty schema in the OpenAPI spec.
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(v.object({ ...vProjectDocFields })),
            pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
            splitCursor: v.optional(v.union(v.string(), v.null())),
        }),
    )
    .query(async ({ args: { organizationId, paginationOpts }, ctx: context }) => {
        const { userId } = context.user;

        if (organizationId) {
            return await listProjectsHandler(context, { organizationId, paginationOpts });
        }

        return await listProjectsHandler(context, { paginationOpts, userId });
    });

export const listPinnedProjects = authQuery
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.array(v.object({ ...vProjectDocFields })))
    .query(async ({ args: { organizationId }, ctx: context }) => {
        const { userId } = context.user;

        if (organizationId) {
            return await listPinnedProjectsHandler(context, { organizationId });
        }

        return await listPinnedProjectsHandler(context, { userId });
    });

export const createProject = authMutation
    .use(rateLimit("projects/create"))
    .input({
        color: v.optional(v.string().max(MAX_LENGTH.short)),
        context: v.optional(v.string().max(MAX_LENGTH.document)),
        defaultEnabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        defaultModel: v.optional(v.string().max(MAX_LENGTH.short)),
        defaultReasoningEffort: v.optional(v.number()),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;

        assertOwnOrganizationId(context.user, args.organizationId);

        const project = await context.runMutation(internal.agent.projects.createProject, {
            ...args,
            userId,
        });

        context.log.event("projects.create_project", { hasOrganization: args.organizationId !== undefined, projectId: project._id });

        return project._id;
    });

export const updateProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        patch: v.object({
            color: v.optional(v.union(v.string().max(MAX_LENGTH.short), v.null())),
            context: v.optional(v.string().max(MAX_LENGTH.document)),
            defaultEnabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            defaultModel: v.optional(v.string().max(MAX_LENGTH.short)),
            defaultReasoningEffort: v.optional(v.number()),
            description: v.optional(v.string().max(MAX_LENGTH.long)),
            icon: v.optional(v.union(v.string().max(MAX_LENGTH.url), v.null())),
            organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
            title: v.optional(v.string().max(MAX_LENGTH.long)),
        }),
        projectId: v.id("projects"),
    })
    .output(v.string())
    .mutation(async ({ args: { patch, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot update another user's project");
        }

        assertOwnOrganizationId(context.user, patch.organizationId);

        const updatedProject = await context.runMutation(internal.agent.projects.updateProject, {
            patch: {
                ...patch,
                color: typeof patch.color === "string" ? patch.color : undefined,
                icon: typeof patch.icon === "string" ? patch.icon : undefined,
            },
            projectId: projectId as Id<"projects">,
        });

        // The repository rows copy the project's organization for `findRepoProject`; a move carries them along.
        // Every row the move names a different organization for, whatever `project` (a replica read) said before: a stale
        // read must not skip the re-stamp.
        if (patch.organizationId !== undefined) {
            // From the primary: a row an add wrote just before this move must not be missed by a lagging replica. An add
            // racing the move re-homes its own row after its insert (`addProjectRepo`).
            const { page: repositories } = await context.db.projectRepositories.findMany({
                consistency: "primary",
                limit: MAX_PROJECT_REPOSITORIES * 2,
                where: { projectId },
            });

            const { organizationId } = patch;

            // One field each, as the project stores it ("" included), never a whole-row replace.
            const stale = repositories.filter((row) => (row.organizationId ?? "") !== organizationId);

            await Promise.all(stale.map((row) => context.db.patch("projectRepositories", row._id, { organizationId })));
        }

        context.log.event("projects.update_project", { projectId, updatedFieldCount: Object.keys(patch).length });

        return updatedProject._id;
    });

/** The project when the caller may change its repositories: the owner, or any member for an organization project nobody owns (as `updateProject`). */
const editableProject = async (context: MutationCtx, projectId: Id<"projects">, userId: string): Promise<Doc<"projects">> => {
    // A member can read the project, so is told it is not theirs to change, not that it is missing.
    const project = await readableProject(context, projectId, userId);

    if (!project) {
        throw new LunoraError("NOT_FOUND", "Project not found");
    }

    if (project.userId && project.userId !== userId) {
        throwForbidden("Only the project's owner can change its repositories");
    }

    return project;
};

/** A stored repo, when the caller may change the project it belongs to (decided on the row's project, never an argument). */
const editableRepo = async (context: MutationCtx, repoId: Id<"projectRepositories">, userId: string): Promise<Doc<"projectRepositories">> => {
    const repo = await context.db.projectRepositories.findFirst({ where: { _id: repoId } });

    if (!repo) {
        throw new LunoraError("NOT_FOUND", "Repository not found");
    }

    await editableProject(context, repo.projectId, userId);

    return repo;
};

/** A refused entry as the client reads it: the reason in English, and `field` and `reason` for it to word in the person's language. */
const refused = (error: ProjectRepoError): LunoraError => new LunoraError("BAD_REQUEST", error.message, { data: { field: error.field, reason: error.reason } });

/** Runs an entry's checks; a refusal reaches the client as the reason and the field it is about. */
const checked = <T>(read: () => T): T => {
    try {
        return read();
    } catch (error) {
        if (error instanceof ProjectRepoError) {
            throw refused(error);
        }

        throw error;
    }
};

/**
 * A project's repo rows, never a delete's marker. More than the cap only while a concurrent add is taking its row back.
 * `primary` reads the authoritative copy, for a check a lagging D1 replica must not answer (the cap).
 */
const repoRows = async (context: MutationCtx | QueryCtx, projectId: Id<"projects">, { primary = false } = {}): Promise<Doc<"projectRepositories">[]> => {
    const { page } = await context.db.projectRepositories.findMany({
        limit: MAX_PROJECT_REPOSITORIES * 2,
        where: { projectId },
        ...(primary && { consistency: "primary" as const }),
    });

    return page.filter((row) => row.deletingAt === undefined);
};

/** Whether a delete of the project is in progress: its marker (`deleteProject`) was written within the TTL. */
const deleteUnderway = async (context: MutationCtx, projectId: Id<"projects">): Promise<boolean> => {
    const marker = await context.db.projectRepositories.findFirst({ consistency: "primary", where: { projectId, url: DELETION_MARKER_URL } });

    return marker?.deletingAt !== undefined && marker.deletingAt > context.now - DELETION_MARKER_TTL_MS;
};

/**
 * Takes back a row this request wrote; a delete running alongside may have erased it already. Read from the primary: a
 * lagging replica that has not seen the insert yet must not skip the delete and leave a refused row listed.
 */
const takeBack = async (context: MutationCtx, id: Id<"projectRepositories">): Promise<void> => {
    if (await context.db.projectRepositories.findFirst({ consistency: "primary", where: { _id: id } })) {
        await context.db.delete("projectRepositories", id);
    }
};

const vProjectRepo = v.object({ defaultBranch: v.optional(v.string()), id: v.string(), isDefault: v.boolean(), revision: v.number(), url: v.string() });

/** The repositories a coding-agent run in the project picks from, oldest first, the default marked. Anyone who can read the project. */
export const listProjectRepos = authQuery
    .input({ projectId: v.id("projects") })
    .output(v.array(vProjectRepo))
    .query(async ({ args: { projectId }, ctx: context }) => {
        if (!(await readableProject(context, projectId as Id<"projects">, context.user.userId))) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        return withDefault(await repoRows(context, projectId as Id<"projects">));
    });

/** Rows one URL lookup reads per scope (the caller's own, their organization's). */
const REPO_LOOKUP_LIMIT = MAX_PROJECT_REPOSITORIES;

/**
 * The oldest project the caller can read that lists this repository, or `null`: a run picker reopened on a saved run
 * shows the project its repository came from (a coding-agent task stores the URL, not the project). Only the caller's
 * own rows and their active organization's are read, each through its index, so other accounts listing the same URL
 * never crowd the caller's out.
 */
export const findRepoProject = authQuery
    .input({ url: v.string().max(MAX_LENGTH.url) })
    .output(v.union(v.object({ projectId: v.string(), title: v.string() }), v.null()))
    .query(async ({ args, ctx: context }) => {
        let url: string;

        try {
            url = normalizeRepoUrl(args.url);
        } catch {
            return null;
        }

        const { userId } = context.user;
        const organizationId = context.user.activeOrganization?.id;
        const own = await context.db.projectRepositories.findMany({ limit: REPO_LOOKUP_LIMIT, where: { url, userId } });
        const shared = organizationId
            ? await context.db.projectRepositories.findMany({ limit: REPO_LOOKUP_LIMIT, where: { organizationId, url } })
            : { page: [] };
        const oldestFirst = [...own.page, ...shared.page].toSorted((left, right) => left._creationTime - right._creationTime);

        for (const row of oldestFirst) {
            const project = await readableProject(context, row.projectId, context.user.userId);

            if (project) {
                return { projectId: project._id, title: project.title };
            }
        }

        return null;
    });

/**
 * Adds one repository. `projectRepositories` is a D1 table, where a read and a later write are not one transaction,
 * so the row is written first and checked after: over the cap, or under a project deleted meanwhile, it is taken back.
 * A repeated URL is refused by the table's unique index.
 */
export const addProjectRepo = authMutation
    .use(rateLimit("projects/update"))
    .input({ defaultBranch: v.optional(v.string().max(200)), projectId: v.id("projects"), url: v.string().max(MAX_LENGTH.url) })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const projectId = args.projectId as Id<"projects">;
        const project = await editableProject(context, projectId, context.user.userId);

        if (await deleteUnderway(context, projectId)) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        const entry = checked(() => {
            return { defaultBranch: normalizeBranch(args.defaultBranch), url: normalizeRepoUrl(args.url) };
        });
        let id: Id<"projectRepositories">;

        try {
            id = await context.db.insert("projectRepositories", {
                branchRevision: 0,
                createdAt: context.now,
                projectId,
                url: entry.url,
                ...(entry.defaultBranch && { defaultBranch: entry.defaultBranch }),
                ...(project.organizationId && { organizationId: project.organizationId }),
                ...(project.userId && { userId: project.userId }),
            });
        } catch (error) {
            const conflict = error as { code?: unknown; kind?: unknown };

            if (conflict.code === "CONFLICT" && conflict.kind === "unique") {
                throw refused(new ProjectRepoError("url", "duplicate", "This repository is already listed"));
            }

            throw error;
        }

        // Over the cap by count, whichever rows the insert stamped first: two adds at once may both be refused, but the
        // list never passes the cap.
        const rows = await repoRows(context, projectId, { primary: true });
        const overCap = rows.length > MAX_PROJECT_REPOSITORIES;
        // Gone, or a delete under way (its marker, written before it erases anything): either way the row goes.
        const current = await systemDb(context).projects.findFirst({ consistency: "primary", where: { _id: projectId } });
        const projectGone = !current || (await deleteUnderway(context, projectId));

        if (projectGone || overCap) {
            await takeBack(context, id);

            throw projectGone
                ? new LunoraError("NOT_FOUND", "Project not found")
                : refused(new ProjectRepoError("url", "limit", `A project can list at most ${String(MAX_PROJECT_REPOSITORIES)} repositories`));
        }

        // A project moved to another organization since it was read here: `updateProject` re-stamped the rows it saw.
        if (current && (current.organizationId ?? "") !== (project.organizationId ?? "")) {
            await context.db.patch("projectRepositories", id, { organizationId: current.organizationId ?? "" });
        }

        context.log.event("projects.add_repository", { projectId });

        return id;
    });

/**
 * Changes one repo's default branch; a blank one clears it, stored as "" (`withDefault` omits it). Only the branch and
 * its revision are patched, never the whole row: a replace from the row read here could undo a default pick or a
 * remove made meanwhile. Returns the new revision, which the caller's next save names. A different URL is a remove and
 * an add.
 */
export const updateProjectRepo = authMutation
    .use(rateLimit("projects/update"))
    .input({ defaultBranch: v.optional(v.string().max(200)), repoId: v.id("projectRepositories"), revision: v.number() })
    .output(v.number())
    .mutation(async ({ args, ctx: context }) => {
        const repo = await editableRepo(context, args.repoId as Id<"projectRepositories">, context.user.userId);
        const defaultBranch = checked(() => normalizeBranch(args.defaultBranch));
        const revision = args.revision + 1;
        // Applied only while the row still has the revision the caller last saw, so an older save that arrives late
        // never replaces a newer one.
        const { applied, doc } = await context.db.patchIf("projectRepositories", repo._id, {
            patch: { branchRevision: revision, defaultBranch: defaultBranch ?? "" },
            where: { branchRevision: args.revision },
        });

        if (!applied && !doc) {
            throw new LunoraError("NOT_FOUND", "Repository not found");
        }

        if (!applied) {
            // The stored revision goes back with the refusal, so the caller's next save can name it without a reload.
            const current = (doc as { branchRevision?: unknown }).branchRevision;

            throw new LunoraError("CONFLICT", "This branch was changed meanwhile", {
                data: { field: "defaultBranch", reason: "stale", revision: typeof current === "number" ? current : 0 },
            });
        }

        return revision;
    });

export const removeProjectRepo = authMutation
    .use(rateLimit("projects/update"))
    .input({ repoId: v.id("projectRepositories") })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const repo = await editableRepo(context, args.repoId as Id<"projectRepositories">, context.user.userId);

        await context.db.delete("projectRepositories", repo._id);
        context.log.event("projects.remove_repository", { projectId: repo.projectId });

        return null;
    });

/**
 * Makes one repo the default a run picker preselects: one row written, the latest pick wins (`withDefault`). The pick
 * is stamped after every earlier one, so a second pick in the same millisecond still wins.
 */
export const setDefaultProjectRepo = authMutation
    .use(rateLimit("projects/update"))
    .input({ repoId: v.id("projectRepositories") })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const repo = await editableRepo(context, args.repoId as Id<"projectRepositories">, context.user.userId);

        const rows = await repoRows(context, repo.projectId);
        const latest = Math.max(0, ...rows.map((row) => row.defaultAt ?? 0));

        await context.db.patch("projectRepositories", repo._id, { defaultAt: Math.max(context.now, latest + 1) });

        return null;
    });

/** Whose a project is, as its repository rows copy it: account deletion erases by `userId`, an organization's by `organizationId`. */
interface ProjectOwner {
    organizationId?: string;
    userId?: string;
}

/** Writes (or renews) the marker of a project delete in progress, stamped like the project's rows so a sweep reaches it. */
const markDeleteUnderway = async (context: MutationCtx, projectId: Id<"projects">, { organizationId, userId }: ProjectOwner): Promise<void> => {
    const marker = await context.db.projectRepositories.findFirst({ consistency: "primary", where: { projectId, url: DELETION_MARKER_URL } });

    if (marker) {
        await context.db.patch("projectRepositories", marker._id, { deletingAt: context.now });

        return;
    }

    try {
        await context.db.insert("projectRepositories", {
            createdAt: context.now,
            deletingAt: context.now,
            projectId,
            url: DELETION_MARKER_URL,
            ...(organizationId && { organizationId }),
            ...(userId && { userId }),
        });
    } catch (error) {
        // A second delete of the same project (a double click) wrote the marker first: it serves both.
        const conflict = error as { code?: unknown; kind?: unknown };

        if (conflict.code !== "CONFLICT" || conflict.kind !== "unique") {
            throw error;
        }
    }
};

/** Removes the marker a delete wrote at `markedAt`; a marker renewed since by a later delete stays. */
const releaseDeleteMarker = async (context: MutationCtx, projectId: Id<"projects">, markedAt: number): Promise<void> => {
    const marker = await context.db.projectRepositories.findFirst({ consistency: "primary", where: { projectId, url: DELETION_MARKER_URL } });

    if (marker?.deletingAt === markedAt) {
        await context.db.delete("projectRepositories", marker._id);
    }
};

/**
 * Runs a project delete under its marker (`markDeleteUnderway`). A delete that fails takes the marker back before the
 * error goes on, so the project, still there, takes repositories again at once rather than after the marker's TTL. A
 * marker renewed by a later delete is left to it; one renewed by an earlier delete still running can be taken, which
 * costs nothing lasting: an add in that window is taken back once the project is gone (`addProjectRepo`), or erased
 * with it. Taking the marker back never hides the delete's own error.
 */
export const underDeleteMarker = async <T>(context: MutationCtx, projectId: Id<"projects">, owner: ProjectOwner, run: () => Promise<T>): Promise<T> => {
    await markDeleteUnderway(context, projectId, owner);

    const markedAt = context.now;

    try {
        return await run();
    } catch (error) {
        await releaseDeleteMarker(context, projectId, markedAt).catch((releaseError: unknown) => {
            context.log.event("projects.delete_marker_release_failed", { error: String(releaseError), projectId });
        });

        throw error;
    }
};

export const deleteProject = authMutation
    .use(rateLimit("projects/delete"))
    .input({
        moveThreadsToProjectId: v.optional(v.string().max(MAX_LENGTH.id)),
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { moveThreadsToProjectId, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot delete another user's project");
        }

        // Threads may only be moved into another project of the caller's.
        if (moveThreadsToProjectId) {
            const target = await context.db.projects.findFirst({ where: { _id: context.db.asId("projects", moveThreadsToProjectId) } });

            if (!target || target.userId !== userId) {
                throw new LunoraError("NOT_FOUND", "Project not found");
            }
        }

        // Under a marker: an add from here on refuses, before and after its insert (`addProjectRepo`); a failed delete
        // takes the marker back.
        await underDeleteMarker(context, projectId as Id<"projects">, { organizationId: project.organizationId, userId: project.userId }, async () => {
            await context.runMutation(internal.agent.projects.deleteProject, {
                moveThreadsToProjectId: (moveThreadsToProjectId || undefined) as Id<"projects"> | undefined,
                projectId: projectId as Id<"projects">,
            });
        });
        // Erased with the project (`agent/projects.ts`, all but the marker), then everything left, the marker included. A
        // row left by a failure here carries the owner's `userId`, so account deletion erases it (`eraseProjectRepositoriesForUser`).
        await eraseProjectRepositories(context, projectId as Id<"projects">);

        context.log.event("projects.delete_project", { movedThreads: Boolean(moveThreadsToProjectId), projectId });

        return { success: true };
    });

export const pinProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot pin another user's project");
        }

        await context.runMutation(internal.agent.projects.pinProject, {
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.pin_project", { projectId });

        return { success: true };
    });

export const unpinProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot unpin another user's project");
        }

        await context.runMutation(internal.agent.projects.unpinProject, {
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.unpin_project", { projectId });

        return { success: true };
    });

export const moveThreadToProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.optional(v.id("projects")),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId, threadId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;

        // Fetch thread and project in parallel for better performance
        const [, project] = await Promise.all([
            requireOwnedThread(context, threadId as Id<"threads">, userId, unlockProof),
            projectId ? context.runQuery(api.agent.projects.getProject, { projectId: projectId as Id<"projects"> }) : Promise.resolve(null),
        ]);

        if (projectId) {
            // Verify project exists and user has access
            if (!project) {
                throw new LunoraError("NOT_FOUND", "Project not found");
            }

            if (project.userId && project.userId !== userId) {
                throwForbidden("Cannot move thread to another user's project");
            }

            await context.runMutation(internal.agent.threads.moveThreadToProject, {
                projectId: projectId as Id<"projects">,
                threadId: threadId as Id<"threads">,
            });
        } else {
            await context.runMutation(internal.agent.threads.removeThreadFromProject, {
                threadId: threadId as Id<"threads">,
            });
        }

        context.log.event("projects.move_thread_to_project", { projectId: projectId ?? null, threadId });

        return { success: true };
    });

export const listThreadsByProject = authQuery
    .input({
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        projectId: v.id("projects"),
    })
    .query(async ({ args: { paginationOpts, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot access another user's project");
        }

        return await context.runQuery(api.agent.projects.listThreadsByProject, {
            paginationOpts,
            projectId: projectId as Id<"projects">,
        });
    });

export const updateProjectOrder = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectOrders: v.array(v.object({ order: v.number(), projectId: v.string().max(MAX_LENGTH.id) })),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectOrders }, ctx: context }) => {
        const { userId } = context.user;

        // Batch verify all projects belong to the user first
        const projectVerificationPromises = projectOrders.map(({ projectId }) =>
            context.runQuery(api.agent.projects.getProject, { projectId: projectId as Id<"projects"> }),
        );
        const projects = await Promise.all(projectVerificationPromises);

        // Filter to only projects owned by the user and update them in parallel
        const updatePromises = projectOrders
            .map(({ order, projectId }, index) => {
                const project = projects[index];

                if (project && project.userId === userId) {
                    return context.runMutation(internal.agent.projects.updateProjectOrder, {
                        projectOrders: [{ order, projectId: projectId as Id<"projects"> }],
                    });
                }

                return null;
            })
            .filter((promise): promise is Promise<any> => promise !== null);

        await Promise.all(updatePromises);

        context.log.event("projects.update_project_order", { requestedCount: projectOrders.length, updatedCount: updatePromises.length });

        return { success: true };
    });
