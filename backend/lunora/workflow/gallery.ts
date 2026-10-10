import type { Infer } from "lunorash/server";
import { signOwnedUrlFieldsForDisplay } from "../lib/stored-url-fields";
import { LunoraError } from "lunorash/server";
// ── Internal Mutations ───────────────────────────────────────────────────────
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { callOnShard } from "../lib/cross-shard";
import { authMutation, publicAction, publicQuery, rateLimit } from "../lib/crpc";
import { rateLimitGuard, shareLinkBucket } from "../lib/rate-limiter";
import { throwForbidden, throwNotFound } from "../lib/error-helpers";
import { MAX_LENGTH } from "../lib/validators";

// Generate a unique share token
const generateToken = (): string => crypto.randomUUID();

// ── Public Gallery Queries ───────────────────────────────────────────────────

/**
 * Browse the community gallery - publicly accessible, no auth required.
 *
 * All three public gallery reads return an explicit projection: no owner id, no
 * org id, no project context, no fork lineage (which could name a private
 * project). Only presentation fields and, for a shared workflow, its content.
 */
const vBrowseGalleryOutput = v.object({ nextCursor: v.union(v.string(), v.null()), page: v.array(v.any()) });

export const browseGallery = publicQuery
    .input({
        category: v.optional(v.union(v.literal("image"), v.literal("text"), v.literal("video"), v.literal("audio"), v.literal("automation"))),
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        limit: v.optional(v.number()),
        sort: v.optional(v.union(v.literal("recent"), v.literal("popular"), v.literal("most-forked"))),
    })
    .output(v.from(vBrowseGalleryOutput))
    .query(async ({ args: { category, cursor, limit = 20, sort = "recent" }, ctx: context }): Promise<Infer<typeof vBrowseGalleryOutput>> => {
        // `projects` is `.global()` (D1): ORM facade, no legacy reader. The base
        // order mirrors the old index walks (`by_public_category` ties on
        // `_creationTime`, `by_public` on `galleryPublishedAt`), which the stable
        // sorts below keep for equal keys. Only workflow projects are listed.
        const { page: workflows } = category
            ? await context.db.projects.findMany({
                  orderBy: [{ _creationTime: "asc" }],
                  where: { galleryCategory: category, isPublic: true, projectType: "workflow" },
              })
            : await context.db.projects.findMany({
                  orderBy: [{ galleryPublishedAt: "asc" }, { _creationTime: "asc" }],
                  where: { isPublic: true, projectType: "workflow" },
              });

        // Sort based on preference
        const sorted = [...workflows];

        switch (sort) {
            case "most-forked": {
                sorted.sort((a, b) => (b.galleryForkCount ?? 0) - (a.galleryForkCount ?? 0));
                break;
            }
            case "popular": {
                sorted.sort((a, b) => (b.galleryViewCount ?? 0) - (a.galleryViewCount ?? 0));
                break;
            }
            default: {
                sorted.sort((a, b) => (b.galleryPublishedAt ?? 0) - (a.galleryPublishedAt ?? 0));
                break;
            }
        }

        // Apply cursor-based pagination
        let startIndex = 0;

        if (cursor) {
            const cursorIndex = sorted.findIndex((p) => p._id === cursor);

            if (cursorIndex !== -1) {
                startIndex = cursorIndex + 1;
            }
        }

        // Public and unauthenticated: the page size is the caller's, so clamp it.
        const pageSize = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
        const page = sorted.slice(startIndex, startIndex + pageSize);
        const nextCursor = page.length === pageSize ? (page[page.length - 1]?._id ?? null) : null;

        return {
            nextCursor,
            page: page.map((p) => {
                return {
                    _id: p._id,
                    color: p.color,
                    description: p.description,
                    edgeCount: p.workflowContent?.edges?.length ?? 0,
                    galleryCategory: p.galleryCategory,
                    galleryFeatured: p.galleryFeatured ?? false,
                    galleryForkCount: p.galleryForkCount ?? 0,
                    galleryPublishedAt: p.galleryPublishedAt,
                    galleryTags: p.galleryTags ?? [],
                    galleryViewCount: p.galleryViewCount ?? 0,
                    icon: p.icon,
                    nodeCount: p.workflowContent?.nodes?.length ?? 0,
                    title: p.title,
                };
            }),
        };
    });

/**
 * Get a public workflow by its share token - no auth required.
 */
export const getPublicWorkflow = publicAction
    .input({
        publicAccessToken: v.string().max(MAX_LENGTH.short),
    })
    .use(rateLimit("share/view"))
    .action(async ({ args: { publicAccessToken }, ctx: context }) => {
        // `projects` is `.global()`, but the storage its graph names is signed
        // against the AUTHOR's vault, on the author's shard — which an anonymous
        // caller is never admitted to. So the read runs there, as the system;
        // `readPublicWorkflow` re-checks the token itself.
        const ownerId = await context.runQuery(internal.workflow.gallery.getPublicWorkflowOwner, { publicAccessToken });

        if (!ownerId) {
            return null;
        }

        // Per-link bucket, now that the token is known to be a live link: a rate-limit row
        // is written only for a real share (see `shareLinkBucket`).
        await rateLimitGuard({
            ...context,
            identifier: await shareLinkBucket(publicAccessToken),
            rateLimitKey: "share/view",
            user: null,
        } as never);

        const workflow = await callOnShard(internal.workflow.gallery.readPublicWorkflow, { publicAccessToken }, { shardKey: ownerId });

        context.log.event("workflow.get_public_workflow", { found: workflow !== null });

        return workflow;
    });

export const getPublicWorkflowOwner = internalQuery
    .input({ publicAccessToken: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { publicAccessToken }, ctx }) => {
        const project = await ctx.db.projects.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { publicAccessToken } });

        return project?.isPublic && project.projectType === "workflow" ? (project.userId ?? null) : null;
    });

/** `getPublicWorkflow`'s read, on the author's shard. */
export const readPublicWorkflow = internalQuery
    .input({
        publicAccessToken: v.string(),
    })
    .query(async ({ args: { publicAccessToken }, ctx: context }) => {
        const project = await context.db.projects.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { publicAccessToken } });

        if (!project || !project.isPublic || project.projectType !== "workflow") {
            return null;
        }

        return {
            _id: project._id,
            color: project.color,
            description: project.description,
            galleryCategory: project.galleryCategory,
            galleryFeatured: project.galleryFeatured ?? false,
            galleryForkCount: project.galleryForkCount ?? 0,
            galleryPublishedAt: project.galleryPublishedAt,
            galleryTags: project.galleryTags ?? [],
            galleryViewCount: project.galleryViewCount ?? 0,
            icon: project.icon,
            title: project.title,
            // The shared view: storage references in node data get fresh signed
            // URLs — only for storage the AUTHOR owns. The viewer is anonymous,
            // and the graph is the author's to fill with any string.
            workflowContent: await signOwnedUrlFieldsForDisplay(context, project.userId, project.workflowContent),
        };
    });

/**
 * Get featured workflows for the gallery homepage.
 */
// Gallery card projection of a `projects` row. Narrower than `browseGallery`'s:
// it omits `galleryFeatured` (always true here) and `edgeCount`.
export const getFeaturedWorkflows = publicQuery
    .output(
        v.array(
            v.object({
                _id: v.id("projects"),
                color: v.optional(v.string()),
                description: v.optional(v.string()),
                galleryCategory: v.optional(v.union(v.literal("image"), v.literal("text"), v.literal("video"), v.literal("audio"), v.literal("automation"))),
                galleryForkCount: v.number(),
                galleryPublishedAt: v.optional(v.number()),
                galleryTags: v.array(v.string()),
                galleryViewCount: v.number(),
                icon: v.optional(v.string()),
                nodeCount: v.number(),
                title: v.string(),
            }),
        ),
    )
    .query(async ({ ctx: context }) => {
        const { page: results } = await context.db.projects.findMany({
            limit: 10,
            orderBy: [{ _creationTime: "asc" }],
            where: { galleryFeatured: true, isPublic: true, projectType: "workflow" },
        });

        return results.map((p) => {
            return {
                _id: p._id,
                color: p.color,
                description: p.description,
                galleryCategory: p.galleryCategory,
                galleryForkCount: p.galleryForkCount ?? 0,
                galleryPublishedAt: p.galleryPublishedAt,
                galleryTags: p.galleryTags ?? [],
                galleryViewCount: p.galleryViewCount ?? 0,
                icon: p.icon,
                nodeCount: p.workflowContent?.nodes?.length ?? 0,
                title: p.title,
            };
        });
    });

// ── Authenticated Mutations ──────────────────────────────────────────────────

/**
 * Publish a workflow to the community gallery.
 */
export const publishWorkflow = authMutation
    .use(rateLimit("projects/update"))
    .input({
        category: v.union(v.literal("image"), v.literal("text"), v.literal("video"), v.literal("audio"), v.literal("automation")),
        projectId: v.id("projects"),
        tags: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    })
    .output(v.object({ publicAccessToken: v.string() }))
    .mutation(async ({ args: { category, projectId, tags }, ctx: context }) => {
        const { userId } = context.user;

        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot publish another user's workflow");
        }

        if (project.projectType !== "workflow") {
            throw new LunoraError("BAD_REQUEST", "Project is not a workflow");
        }

        if (project.isPublic) {
            throw new LunoraError("BAD_REQUEST", "Workflow is already published");
        }

        // Require at least one node to publish
        const content = project.workflowContent;

        if (!content?.nodes?.length) {
            throw new LunoraError("BAD_REQUEST", "Cannot publish an empty workflow");
        }

        const publicAccessToken = generateToken();

        await context.runMutation(internal.agent.projects.updateProject, {
            patch: {
                galleryCategory: category,
                galleryForkCount: 0,
                galleryPublishedAt: context.now,
                galleryTags: tags ?? [],
                galleryViewCount: 0,
                isPublic: true,
                publicAccessToken,
            },
            projectId: projectId as Id<"projects">,
        });

        context.log.event("workflow.publish_workflow", { category, hasTags: tags !== undefined });

        return { publicAccessToken };
    });

/**
 * Unpublish a workflow from the community gallery.
 */
export const unpublishWorkflow = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot unpublish another user's workflow");
        }

        if (!project.isPublic) {
            throw new LunoraError("BAD_REQUEST", "Workflow is not published");
        }

        // `isPublic: false` is what hides the workflow; the timestamp and the share token
        // are kept, so a re-publish keeps its link. An absent patch key means "unchanged".
        await context.runMutation(internal.agent.projects.updateProject, {
            patch: {
                isPublic: false,
            },
            projectId: projectId as Id<"projects">,
        });

        context.log.event("workflow.unpublish_workflow", { unpublished: true });

        return { success: true };
    });

/**
 * Update gallery metadata for a published workflow.
 */
export const updateGalleryMeta = authMutation
    .use(rateLimit("projects/update"))
    .input({
        category: v.optional(v.union(v.literal("image"), v.literal("text"), v.literal("video"), v.literal("audio"), v.literal("automation"))),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        projectId: v.id("projects"),
        tags: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { category, description, projectId, tags }, ctx: context }) => {
        const { userId } = context.user;

        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot update another user's workflow");
        }

        if (!project.isPublic) {
            throw new LunoraError("BAD_REQUEST", "Workflow is not published");
        }

        const patch: { description?: string; galleryCategory?: "audio" | "automation" | "image" | "text" | "video"; galleryTags?: string[] } = {};

        if (category !== undefined) {
            patch.galleryCategory = category;
        }

        if (tags !== undefined) {
            patch.galleryTags = tags;
        }

        if (description !== undefined) {
            patch.description = description;
        }

        await context.runMutation(internal.agent.projects.updateProject, {
            patch,
            projectId: projectId as Id<"projects">,
        });

        context.log.event("workflow.update_gallery_meta", { hasCategory: category !== undefined, hasTags: tags !== undefined });

        return { success: true };
    });
