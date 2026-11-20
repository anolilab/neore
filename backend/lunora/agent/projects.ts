/**
 * Project operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { patchRow, withoutUndefined } from "../lib/patch";
import { assert } from "../lib/error-helpers";
import { paginationOptionsValidator, MAX_LENGTH } from "../lib/validators";
import {
    type ProjectDoc as ProjectDocument,
    vPaginationResult,
    vProjectCreateFields,
    vProjectPatchFields,
    vProjectDoc as vProjectDocument,
    vThreadDoc as vThreadDocument,
} from "./validators";
import { admitOrganization } from "../lib/rls/scope";
import { countedWorkflowFileIds } from "../workflow/images";
import { changeRefcount } from "./files";
import { listThreadItem } from "./threads";
import { eraseProjectRepositories } from "../projects/gdpr";
import { mayEditProject } from "../projects/edit-access";
import { forViewer } from "../projects/machine-location";
import { findProjectRow, findProjectRows, type ProjectRow } from "../projects/project-row";
import { assertProjectRowFits, projectRuleFiles, ruleFilesRevision } from "../projects/rule-files";

/**
 * A workflow keeps its images and reference media as chat-file references
 * (`imageFileId`, a file node's `fileId`), and a chat file nothing counts is
 * deleted by the unused-file sweep. So every write of `workflowContent` retains
 * the owner-granted files it adds and releases the ones it drops — as message
 * `fileIds` do.
 */
const recountWorkflowImages = async (ctx: MutationCtx, ownerId: string | undefined, previousContent: unknown, nextContent: unknown): Promise<void> => {
    if (!ownerId) {
        return;
    }

    const { next, previous } = await countedWorkflowFileIds(ctx.db, ownerId, previousContent, nextContent);

    await changeRefcount(ctx, previous, next);
};

/**
 * A project row as the project procedures return it: read without its rule files (`PROJECT_ROW_COLUMNS`), up to 1 MB a
 * project, which a list would read for every row. They are read through `projects.functions.listProjectRuleFiles` only.
 */
export const publicProject = (project: ProjectRow): ProjectDocument =>
    // Safe cast: optional fields are never null at runtime (only undefined).
    // The column builders generate null|T types in TypeScript only.
    project as unknown as ProjectDocument;

/** The project `projectId` without its rule files, or `null`. */
const projectRow = async (ctx: QueryCtx | MutationCtx, projectId: Id<"projects">): Promise<ProjectRow | null> =>
    await findProjectRow(ctx.db.projects, { where: { _id: projectId } });

export const getProject = query
    .input({ projectId: v.id("projects") })
    .output(v.from(v.union(vProjectDocument, v.null())))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const project = await projectRow(ctx, args.projectId);

        if (!project) {
            return null;
        }

        // Owner only. A PUBLIC gallery project is served by `workflow_gallery.*`,
        // which projects it; this returned the whole row (context, org id, raw
        // storage refs) to any caller holding its id.
        if (project.userId !== identity.userId) {
            return null;
        }

        return publicProject(project);
    });

/** The project list read, shared by the public query and the owner's wrapper in `projects/functions.ts`. */
export const listProjectsHandler = async (
    ctx: QueryCtx,
    args: {
        organizationId?: string;
        paginationOpts?: { cursor: string | null; endCursor?: string | null; id?: number; numItems: number };
        userId?: string;
    },
) => {
    const identity = await getAuthUserIdentity(ctx);

    if (!identity) {
        return { continueCursor: "" as string, isDone: true, page: [] };
    }

    if (!args.userId && !args.organizationId) {
        return {
            continueCursor: "" as string,
            isDone: true,
            page: [],
        };
    }

    // Users can only list their own projects, or those of an organization they
    // are a MEMBER of. The org branch below reads `by_organization` with no owner
    // filter, so without the membership check any caller naming an org id read
    // its full project rows (context, workflow content, share tokens).
    if (args.userId && args.userId !== identity.userId) {
        return { continueCursor: "" as string, isDone: true, page: [] };
    }

    if (!args.userId && args.organizationId) {
        if (!(await getMemberByOrganizationAndUser(ctx, args.organizationId, identity.userId))) {
            return { continueCursor: "" as string, isDone: true, page: [] };
        }

        // A proven membership: other members' projects of that org pass row-level security.
        admitOrganization(ctx, args.organizationId);
    }

    // `projects` is `.global()` (D1): no legacy reader, so the ORM facade.
    // The order mirrors the old descending index walk — `by_user_and_pinned`
    // is (userId, pinnedAt, _creationTime), `by_organization` is
    // (organizationId, _creationTime).
    const paginationOptions = args.paginationOpts ?? { cursor: null, numItems: 100 };
    const projects = args.userId
        ? await findProjectRows(ctx.db.projects, {
              cursor: paginationOptions.cursor,
              limit: paginationOptions.numItems,
              orderBy: [{ pinnedAt: "desc" }, { _creationTime: "desc" }],
              where: { userId: args.userId },
          })
        : await findProjectRows(ctx.db.projects, {
              cursor: paginationOptions.cursor,
              limit: paginationOptions.numItems,
              orderBy: [{ _creationTime: "desc" }],
              where: { organizationId: args.organizationId as string },
          });

    return {
        continueCursor: projects.continueCursor,
        isDone: projects.isDone,
        page: projects.page.map((item) => publicProject(forViewer(item, identity.userId))),
    };
};

export const listProjects = query
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        paginationOpts: v.optional(paginationOptionsValidator),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(vPaginationResult(vProjectDocument)))
    .query(async ({ args, ctx }) => await listProjectsHandler(ctx, args));

export const listPinnedProjectsHandler = async (ctx: QueryCtx, args: { organizationId?: string; userId?: string }) => {
    const identity = await getAuthUserIdentity(ctx);

    if (!identity) {
        return [];
    }

    if (args.userId && args.userId !== identity.userId) {
        return [];
    }

    if (args.userId) {
        const { page } = await findProjectRows(ctx.db.projects, {
            limit: 200,
            orderBy: [{ pinnedAt: "asc" }, { _creationTime: "asc" }],
            where: { pinnedAt: { gte: 0 }, userId: args.userId },
        });
        const pinned = page.filter((p) => p.pinnedAt !== undefined).toSorted((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

        return pinned.map((item) => publicProject(forViewer(item, identity.userId)));
    }

    // Membership, not just an org id: see `listProjects`.
    if (args.organizationId && (await getMemberByOrganizationAndUser(ctx, args.organizationId, identity.userId))) {
        admitOrganization(ctx, args.organizationId);

        const { page } = await findProjectRows(ctx.db.projects, {
            limit: 200,
            orderBy: [{ _creationTime: "asc" }],
            where: { organizationId: args.organizationId },
        });
        const pinned = page.filter((p) => p.pinnedAt !== undefined).toSorted((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

        return pinned.map((item) => publicProject(forViewer(item, identity.userId)));
    }

    return [];
};

export const listPinnedProjects = query
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(v.array(vProjectDocument)))
    .query(async ({ args, ctx }) => await listPinnedProjectsHandler(ctx, args));

export const createProject = internalMutation
    .input(vProjectCreateFields)
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const insertedId = await ctx.db.insert("projects", {
            ...args,
            createdAt: ctx.now,
        });
        const projectId = insertedId as Id<"projects">;

        await recountWorkflowImages(ctx, args.userId, undefined, args.workflowContent);

        const project = await projectRow(ctx, projectId);

        assert(project, `Project ${projectId} not found`);

        return publicProject(project);
    });

export const projectFieldsSupportingPatch = [
    "title" as const,
    "description" as const,
    "context" as const,
    "color" as const,
    "icon" as const,
    "defaultModel" as const,
    "defaultReasoningEffort" as const,
    "defaultEnabledFeatures" as const,
    "organizationId" as const,
    "projectType" as const,
    "workflowContent" as const,
    "isPublic" as const,
    "publicAccessToken" as const,
    "galleryCategory" as const,
    "galleryTags" as const,
    "galleryFeatured" as const,
    "galleryForkCount" as const,
    "galleryViewCount" as const,
    "galleryPublishedAt" as const,
    "forkedFromId" as const,
    "ruleFiles" as const,
] as const;

export type ProjectFieldsSupportingPatch = (typeof projectFieldsSupportingPatch)[number];

export const updateProject = internalMutation
    .input({
        patch: v.object({ ...vProjectPatchFields }),
        projectId: v.id("projects"),
        /** When set, the rule files' revision the change was made from (`ruleFilesRevision`); another one is refused. */
        ruleFilesRevision: v.optional(v.string()),
        /**
         * When set, the user the change is made for: refused (NOT_FOUND) unless they still own the project in this
         * transaction, so a change checked in an earlier one cannot land after the project changed hands.
         */
        settingsEditorId: v.optional(v.string()),
    })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ consistency: "primary", where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);

        if (args.settingsEditorId !== undefined && !mayEditProject(project, args.settingsEditorId)) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        // Read and written in this one transaction: a save from a view older than another save is refused, never applied over it.
        if (args.ruleFilesRevision !== undefined && args.ruleFilesRevision !== ruleFilesRevision(projectRuleFiles(project))) {
            throw new LunoraError("CONFLICT", "The rule files were changed meanwhile. Reload them and save again.");
        }

        // Absent keys stay as they are; an empty colour, icon or context is the
        // client's way of saying "remove it", which `patchRow` does for an `undefined`.
        const changes: Record<string, unknown> = { ...withoutUndefined(args.patch), updatedAt: ctx.now };

        for (const key of ["color", "context", "icon"] as const) {
            if (args.patch[key] === "") {
                changes[key] = undefined;
            }
        }

        // A rule-file save is the one that can grow the row by up to a megabyte: refuse it here, on the row as written.
        if (args.patch.ruleFiles !== undefined) {
            assertProjectRowFits({ ...project, ...changes }, project);
        }

        await patchRow(ctx.db, "projects", project, changes);

        if (args.patch.workflowContent !== undefined) {
            await recountWorkflowImages(ctx, project.userId, project.workflowContent, args.patch.workflowContent);
        }

        const updatedProject = await projectRow(ctx, args.projectId);

        assert(updatedProject, `Project ${args.projectId} not found`);

        return publicProject(updatedProject);
    });

export const deleteProject = internalMutation
    .input({
        moveThreadsToProjectId: v.optional(v.id("projects")),
        projectId: v.id("projects"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const project = await findProjectRow(ctx.db.projects, { where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);

        if (args.moveThreadsToProjectId) {
            const targetProject = await findProjectRow(ctx.db.projects, { where: { _id: args.moveThreadsToProjectId } });

            assert(targetProject, `Target project ${args.moveThreadsToProjectId} not found`);
        }

        const projectThreads = await ctx.db
            .query("threads")
            .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
            .collect();

        for (const thread of projectThreads) {
            await patchRow(ctx.db, "threads", thread, {
                projectId: args.moveThreadsToProjectId,
                updatedAt: ctx.now,
            });
        }

        // Its repositories go last before the row, so a check or thread move that fails above leaves both in place. The
        // delete's marker stays until the caller is done (`projects/functions.ts#deleteProject`).
        await eraseProjectRepositories(ctx, args.projectId, { keepMarker: true });
        await ctx.db.delete("projects", args.projectId);
        await recountWorkflowImages(ctx, project.userId, project.workflowContent, undefined);

        return null;
    });

export const pinProject = internalMutation
    .input({ projectId: v.id("projects") })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await findProjectRow(ctx.db.projects, { where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        await ctx.db.patch("projects", args.projectId, {
            pinnedAt: ctx.now,
            updatedAt: ctx.now,
        });
        const updatedProject = (await projectRow(ctx, args.projectId))!;

        return publicProject(updatedProject);
    });

export const unpinProject = internalMutation
    .input({ projectId: v.id("projects") })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        await patchRow(ctx.db, "projects", project, {
            pinnedAt: undefined,
            updatedAt: ctx.now,
        });

        const updatedProject = (await projectRow(ctx, args.projectId))!;

        return publicProject(updatedProject);
    });

export const updateProjectOrder = internalMutation
    .input({
        projectOrders: v.array(
            v.object({
                order: v.number(),
                projectId: v.id("projects"),
            }),
        ),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const updatePromises = args.projectOrders.map(({ order, projectId }) =>
            ctx.db.patch("projects", projectId, {
                order,
                updatedAt: ctx.now,
            }),
        );

        await Promise.all(updatePromises);

        return null;
    });

export const listThreadsByProject = query
    .input({
        paginationOpts: v.optional(paginationOptionsValidator),
        projectId: v.id("projects"),
    })
    .output(v.from(vPaginationResult(vThreadDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return { continueCursor: "", isDone: true, page: [], pageStatus: null, splitCursor: null };
        }

        const project = await findProjectRow(ctx.db.projects, { where: { _id: args.projectId } });

        if (!project || project.userId !== identity.userId) {
            return { continueCursor: "", isDone: true, page: [], pageStatus: null, splitCursor: null };
        }

        // `by_projectId`, newest first, on the ORM facade. (Behind row-level
        // security the legacy `paginate` read the project's whole index range
        // until `@lunora/server@alpha.145`, anolilab/lunora#822.)
        const paginationOptions = args.paginationOpts ?? { cursor: null, numItems: 100 };
        const threads = await ctx.db.threads.findMany({
            cursor: paginationOptions.cursor,
            limit: paginationOptions.numItems,
            orderBy: [{ projectId: "desc" }, { _creationTime: "desc" }],
            where: { projectId: args.projectId },
        });

        return {
            continueCursor: threads.continueCursor,
            isDone: threads.isDone,
            page: threads.page.map((item) => listThreadItem(item as unknown as Doc<"threads">)),
        };
    });

/**
 * Count one view of a public gallery project. Moved here from
 * `workflow/gallery.ts` because this module owns `projects`; nothing calls it
 * yet.
 */
export const incrementViewCount = internalMutation
    .input({
        projectId: v.id("projects"),
    })
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const project = await findProjectRow(context.db.projects, { where: { _id: projectId } });

        if (project && project.isPublic) {
            await context.db.patch("projects", projectId, {
                galleryViewCount: (project.galleryViewCount ?? 0) + 1,
            });
        }
    });
