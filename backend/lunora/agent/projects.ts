/**
 * Project operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { omit, pick } from "../lib/collections";
import { patchRow, withoutUndefined } from "../lib/patch";
import { assert } from "../lib/error-helpers";
import { paginationOptionsValidator, partial, MAX_LENGTH } from "../lib/validators";
import {
    type ProjectDoc as ProjectDocument,
    type ThreadDoc,
    vPaginationResult,
    vProjectCreateFields,
    vProjectDoc as vProjectDocument,
    vProjectDocFields as vProjectDocumentFields,
    vThreadDoc as vThreadDocument,
} from "./validators";
import { admitOrganization } from "../lib/rls/scope";
// Helper to convert thread to public format (omits parentThreadIds)
const publicThread = (thread: Doc<"threads">): ThreadDoc =>
    // Safe cast: optional fields are never null at runtime (only undefined).
    // The column builders generate null|T types in TypeScript only.
    omit(thread, ["parentThreadIds"]) as unknown as ThreadDoc;

export const publicProject = (project: Doc<"projects">): ProjectDocument =>
    // Safe cast: optional fields are never null at runtime (only undefined).
    // The column builders generate null|T types in TypeScript only.
    project as unknown as ProjectDocument;

export const getProject = query
    .input({ projectId: v.id("projects") })
    .output(v.from(v.union(vProjectDocument, v.null())))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

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

export const listProjects = query
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        paginationOpts: v.optional(paginationOptionsValidator),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(vPaginationResult(vProjectDocument)))
    .query(async ({ args, ctx }) => {
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
            ? await ctx.db.projects.findMany({
                  cursor: paginationOptions.cursor,
                  limit: paginationOptions.numItems,
                  orderBy: [{ pinnedAt: "desc" }, { _creationTime: "desc" }],
                  where: { userId: args.userId },
              })
            : await ctx.db.projects.findMany({
                  cursor: paginationOptions.cursor,
                  limit: paginationOptions.numItems,
                  orderBy: [{ _creationTime: "desc" }],
                  where: { organizationId: args.organizationId as string },
              });

        return {
            continueCursor: projects.continueCursor,
            isDone: projects.isDone,
            page: (projects.page as unknown as Doc<"projects">[]).map((item) => publicProject(item)),
        };
    });

export const listPinnedProjects = query
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(v.array(vProjectDocument)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        if (args.userId && args.userId !== identity.userId) {
            return [];
        }

        if (args.userId) {
            const { page: projects } = await ctx.db.projects.findMany({
                limit: 200,
                orderBy: [{ pinnedAt: "asc" }, { _creationTime: "asc" }],
                where: { pinnedAt: { gte: 0 }, userId: args.userId },
            });
            const pinned = projects.filter((p) => p.pinnedAt !== undefined).toSorted((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

            return pinned.map((item) => publicProject(item));
        }

        // Membership, not just an org id: see `listProjects`.
        if (args.organizationId && (await getMemberByOrganizationAndUser(ctx, args.organizationId, identity.userId))) {
            admitOrganization(ctx, args.organizationId);

            const { page: allProjects } = await ctx.db.projects.findMany({
                limit: 200,
                orderBy: [{ _creationTime: "asc" }],
                where: { organizationId: args.organizationId },
            });
            const pinned = allProjects.filter((p) => p.pinnedAt !== undefined).toSorted((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

            return pinned.map((item) => publicProject(item));
        }

        return [];
    });

export const createProject = internalMutation
    .input(vProjectCreateFields)
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const insertedId = await ctx.db.insert("projects", {
            ...args,
            createdAt: ctx.now,
        });
        const projectId = insertedId as Id<"projects">;

        const project = await ctx.db.projects.findFirst({ where: { _id: projectId } });

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
] as const;

export type ProjectFieldsSupportingPatch = (typeof projectFieldsSupportingPatch)[number];

export const updateProject = internalMutation
    .input({
        patch: v.object(partial(pick(vProjectDocumentFields, [...projectFieldsSupportingPatch]))),
        projectId: v.id("projects"),
    })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        // Absent keys stay as they are; an empty colour or icon is the client's
        // way of saying "remove it", which `patchRow` does for an `undefined`.
        const changes: Record<string, unknown> = { ...withoutUndefined(args.patch), updatedAt: ctx.now };

        for (const key of ["color", "icon"] as const) {
            if (args.patch[key] === "") {
                changes[key] = undefined;
            }
        }

        await patchRow(ctx.db, project, changes);

        const updatedProject = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

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
        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);

        if (args.moveThreadsToProjectId) {
            const targetProject = await ctx.db.projects.findFirst({ where: { _id: args.moveThreadsToProjectId } });

            assert(targetProject, `Target project ${args.moveThreadsToProjectId} not found`);
        }

        const projectThreads = await ctx.db
            .query("threads")
            .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
            .collect();

        for (const thread of projectThreads) {
            await patchRow(ctx.db, thread, {
                projectId: args.moveThreadsToProjectId,
                updatedAt: ctx.now,
            });
        }

        await ctx.db.delete(args.projectId);

        return null;
    });

export const pinProject = internalMutation
    .input({ projectId: v.id("projects") })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        await ctx.db.patch(args.projectId, {
            pinnedAt: ctx.now,
            updatedAt: ctx.now,
        });
        const updatedProject = (await ctx.db.projects.findFirst({ where: { _id: args.projectId } }))!;

        return publicProject(updatedProject);
    });

export const unpinProject = internalMutation
    .input({ projectId: v.id("projects") })
    .output(v.from(vProjectDocument))
    .mutation(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        assert(project, `Project ${args.projectId} not found`);
        await patchRow(ctx.db, project, {
            pinnedAt: undefined,
            updatedAt: ctx.now,
        });

        const updatedProject = (await ctx.db.projects.findFirst({ where: { _id: args.projectId } }))!;

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
            ctx.db.patch(projectId, {
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

        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

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
            page: threads.page.map((item) => publicThread(item as unknown as Doc<"threads">)),
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
        const project = await context.db.projects.findFirst({ where: { _id: projectId } });

        if (project && project.isPublic) {
            await context.db.patch(projectId, {
                galleryViewCount: (project.galleryViewCount ?? 0) + 1,
            });
        }
    });
