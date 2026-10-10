/**
 * Knowledge collections — named libraries of knowledge files.
 *
 * A collection is a `.global()` row, so members of the organization it is
 * shared with can list it and attach it; its FILES stay on the owner's shard
 * (`knowledgeFiles.collectionId`), where only the owner writes them. A file
 * with no collection is "uncategorised", which is every file that existed
 * before collections did.
 *
 * Sharing follows prompts: `organizationId` is set only when the owner shares
 * the collection, and only with their ACTIVE organization (the membership
 * `ctx.user` proves). Members read and attach; editing, filing and deleting
 * stay with the owner. Reading a shared collection's passages happens on the
 * owner's shard (`knowledge_retrieve.searchSharedCollections`,
 * {@link listCollectionFiles}), each time re-checking the membership there.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { requireOwnedThread, requireThreadPermission } from "../agent/thread-read-access";
import { getMemberByOrganizationAndUser, getMembersByUserId } from "../auth/lib/better-auth-queries";
import { callOnShard } from "../lib/cross-shard";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { DELETING_STATUS } from "./file-removal";
import { canReadCollection, planRetrievalScope } from "./scope";
import { MAX_LENGTH } from "../lib/validators";

export const MAX_COLLECTIONS = 100;
export const MAX_COLLECTION_NAME = 80;
export const MAX_COLLECTION_DESCRIPTION = 500;
/** Files one call may file into a collection. */
const MAX_FILES_PER_MOVE = 100;
/**
 * Files a collection may hold and still be deleted in one call. Unfiling
 * patches a field; deleting with the files only MARKS them (the chunks are
 * drained in the background), so both cost one patch per file.
 */
const MAX_FILES_UNFILED_WITH_COLLECTION = 1000;

type Collection = Doc<"knowledgeCollections">;
type Db = MutationCtx["db"] | QueryCtx["db"];

const cleanName = (name: string): string => {
    const trimmed = name.trim();

    if (trimmed.length === 0 || trimmed.length > MAX_COLLECTION_NAME) {
        throw new LunoraError("BAD_REQUEST", `Collection names are 1-${String(MAX_COLLECTION_NAME)} characters`);
    }

    return trimmed;
};

const cleanDescription = (description: string | undefined): string | undefined => {
    const trimmed = description?.trim();

    if (trimmed && trimmed.length > MAX_COLLECTION_DESCRIPTION) {
        throw new LunoraError("BAD_REQUEST", `Descriptions are at most ${String(MAX_COLLECTION_DESCRIPTION)} characters`);
    }

    return trimmed || undefined;
};

/** The caller's OWN collection, or NOT_FOUND — never FORBIDDEN, so a probe learns nothing. */
const requireOwnCollection = async (db: Db, collectionId: Id<"knowledgeCollections">, userId: string): Promise<Collection> => {
    const collection = await db.knowledgeCollections.findFirst({ where: { _id: collectionId } });

    if (!collection || collection.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Collection not found");
    }

    return collection;
};

/**
 * A collection the caller may attach: their own, or one shared with their
 * active organization. Row-level security already hides the rest; the check
 * restates the rule so the procedure does not depend on it.
 */
const requireReadableCollection = async (
    ctx: { db: Db; user: { activeOrganization?: { id: string } | null; userId: string } },
    collectionId: Id<"knowledgeCollections">,
): Promise<Collection> => {
    const collection = await ctx.db.knowledgeCollections.findFirst({ where: { _id: collectionId } });
    const activeOrganizationId = ctx.user.activeOrganization?.id;

    if (!collection || !canReadCollection(collection, ctx.user.userId, new Set(activeOrganizationId ? [activeOrganizationId] : []))) {
        throw new LunoraError("NOT_FOUND", "Collection not found");
    }

    return collection;
};

const vCollectionView = v.object({
    _id: v.id("knowledgeCollections"),
    createdAt: v.number(),
    description: v.optional(v.string()),
    isOwner: v.boolean(),
    name: v.string(),
    shared: v.boolean(),
    updatedAt: v.number(),
});

const toView = (collection: Collection, userId: string) => {
    return {
        _id: collection._id,
        createdAt: collection.createdAt,
        description: collection.description,
        isOwner: collection.userId === userId,
        name: collection.name,
        shared: Boolean(collection.organizationId),
        updatedAt: collection.updatedAt,
    };
};

// ============================================================================
// Collections
// ============================================================================

/** The caller's collections, then those shared with their active organization. */
export const listCollections = authQuery
    .input({})
    .output(v.array(vCollectionView))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;
        const [own, shared] = await Promise.all([
            ctx.db.knowledgeCollections.findMany({ limit: MAX_COLLECTIONS, where: { userId } }).then((result) => result.page),
            organizationId
                ? ctx.db.knowledgeCollections.findMany({ limit: MAX_COLLECTIONS, where: { organizationId } }).then((result) => result.page)
                : Promise.resolve([] as Collection[]),
        ]);
        const others = shared.filter((collection) => collection.userId !== userId);

        return [...own, ...others].map((collection) => toView(collection, userId)).toSorted((a, b) => a.name.localeCompare(b.name));
    });

export const createCollection = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        name: v.string().max(MAX_LENGTH.short),
        shareWithOrganization: v.optional(v.boolean()),
    })
    .output(v.id("knowledgeCollections"))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        if (args.shareWithOrganization && !organizationId) {
            throw new LunoraError("BAD_REQUEST", "Switch to an organization to share a collection with it");
        }

        const { page: existing } = await ctx.db.knowledgeCollections.findMany({ limit: MAX_COLLECTIONS, where: { userId } });

        if (existing.length >= MAX_COLLECTIONS) {
            throw new LunoraError("UNPROCESSABLE", `You can have at most ${String(MAX_COLLECTIONS)} collections`);
        }

        const now = ctx.now;

        const collectionId = await ctx.db.insert("knowledgeCollections", {
            createdAt: now,
            description: cleanDescription(args.description),
            name: cleanName(args.name),
            organizationId: args.shareWithOrganization ? organizationId : undefined,
            updatedAt: now,
            userId,
        });

        ctx.log.event("knowledge.create_collection", { shared: args.shareWithOrganization === true });

        return collectionId;
    });

/** Rename, describe, or (un)share. Owner only; sharing goes to the ACTIVE organization. */
export const updateCollection = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        collectionId: v.id("knowledgeCollections"),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        shareWithOrganization: v.optional(v.boolean()),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const collection = await requireOwnCollection(ctx.db, args.collectionId, ctx.user.userId);
        const changes: Record<string, unknown> = { updatedAt: ctx.now };

        if (args.name !== undefined) {
            changes.name = cleanName(args.name);
        }

        if (args.description !== undefined) {
            // An empty description removes it.
            changes.description = cleanDescription(args.description);
        }

        if (args.shareWithOrganization !== undefined) {
            const organizationId = ctx.user.activeOrganization?.id;

            if (args.shareWithOrganization && !organizationId) {
                throw new LunoraError("BAD_REQUEST", "Switch to an organization to share a collection with it");
            }

            changes.organizationId = args.shareWithOrganization ? organizationId : undefined;
        }

        await patchRow(ctx.db, collection, changes);

        ctx.log.event("knowledge.update_collection", { sharingChanged: args.shareWithOrganization !== undefined });

        return null;
    });

/**
 * Deletes a collection. Its files become uncategorised, or — with
 * `deleteFiles` — are removed with their chunks and embeddings: marked
 * {@link DELETING_STATUS} here, so they vanish from the user's lists at once,
 * and drained in bounded batches by `knowledge_housekeeping.drainDeletingFiles`
 * (a file can hold thousands of chunks). Links to it on the caller's shard go
 * too; a member's links on their own shard are skipped at retrieval from then
 * on (`planRetrievalScope`).
 */
export const deleteCollection = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({
        collectionId: v.id("knowledgeCollections"),
        deleteFiles: v.optional(v.boolean()),
    })
    .output(v.object({ filesDeleted: v.number(), filesUnfiled: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const collection = await requireOwnCollection(ctx.db, args.collectionId, userId);
        const cap = MAX_FILES_UNFILED_WITH_COLLECTION;
        const files = await ctx.db
            .query("knowledgeFiles")
            .withIndex("by_userId_collectionId", (q) => q.eq("userId", userId).eq("collectionId", collection._id))
            .take(cap + 1);

        if (files.length > cap) {
            throw new LunoraError("UNPROCESSABLE", `This collection holds more than ${String(cap)} files; move or remove some first`);
        }

        const now = ctx.now;

        for (const file of files) {
            await (args.deleteFiles
                ? ctx.db.patch(file._id, { status: DELETING_STATUS, updatedAt: now })
                : patchRow(ctx.db, file, { collectionId: undefined, updatedAt: now }));
        }

        if (args.deleteFiles && files.length > 0) {
            await ctx.scheduler.runAfter(0, internal.knowledge.housekeeping.drainDeletingFiles, {});
        }

        const links = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_collectionId", (q) => q.eq("collectionId", collection._id))
            .collect();

        await Promise.all(links.map((link) => ctx.db.delete(link._id)));
        await ctx.db.delete(collection._id);

        ctx.log.event("knowledge.delete_collection", { deleteFiles: args.deleteFiles === true, fileCount: files.length });

        return args.deleteFiles ? { filesDeleted: files.length, filesUnfiled: 0 } : { filesDeleted: 0, filesUnfiled: files.length };
    });

/**
 * Files the caller owns into one of their own collections, or — with no
 * `collectionId` — back to uncategorised. A shared collection someone else
 * owns cannot hold the caller's files: they would live on a different shard.
 */
export const setFileCollection = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        collectionId: v.optional(v.id("knowledgeCollections")),
        fileIds: v.array(v.id("knowledgeFiles")),
    })
    .output(v.object({ updated: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        if (args.fileIds.length > MAX_FILES_PER_MOVE) {
            throw new LunoraError("BAD_REQUEST", `Move at most ${String(MAX_FILES_PER_MOVE)} files at a time`);
        }

        if (args.collectionId) {
            await requireOwnCollection(ctx.db, args.collectionId, userId);
        }

        const files = await Promise.all([...new Set(args.fileIds)].map(async (fileId) => await ctx.db.get(fileId)));

        if (files.some((file) => !file || file.userId !== userId)) {
            throw new LunoraError("NOT_FOUND", "Knowledge file not found");
        }

        for (const file of files) {
            await patchRow(ctx.db, file!, { collectionId: args.collectionId, updatedAt: ctx.now });
        }

        ctx.log.event("knowledge.set_file_collection", { fileCount: files.length, moved: args.collectionId !== undefined });

        return { updated: files.length };
    });

// ============================================================================
// Attaching a collection to a thread or a project
// ============================================================================

const vLinkedCollection = v.object({
    addedAt: v.number(),
    collectionId: v.id("knowledgeCollections"),
    isOwner: v.boolean(),
    name: v.string(),
});

/** The linked collections still readable through `db`, with their names. A deleted or unshared one drops out. */
const describeLinks = async (db: Db, links: Doc<"knowledgeCollectionLinks">[], userId: string) => {
    const rows = await Promise.all(
        links.map(async (link) => {
            const collection = await db.knowledgeCollections.findFirst({ where: { _id: link.collectionId } });

            return collection ? { addedAt: link.addedAt, collectionId: collection._id, isOwner: collection.userId === userId, name: collection.name } : null;
        }),
    );

    return rows.filter((row) => row !== null);
};

/** Thread links belong to the thread's OWNER, as file links do (`attachToThread`). */
export const attachCollectionToThread = authMutation
    .use(rateLimit("knowledge/add"))
    .input({ collectionId: v.id("knowledgeCollections"), threadId: v.id("threads") })
    .output(v.object({ alreadyAttached: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireOwnedThread(ctx, args.threadId, userId);
        await requireReadableCollection(ctx, args.collectionId);

        const existing = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
            .collect();

        if (existing.some((link) => link.collectionId === args.collectionId)) {
            return { alreadyAttached: true };
        }

        await ctx.db.insert("knowledgeCollectionLinks", { addedAt: ctx.now, collectionId: args.collectionId, threadId: args.threadId, userId });

        ctx.log.event("knowledge.attach_collection", { scope: "thread" });

        return { alreadyAttached: false };
    });

export const detachCollectionFromThread = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({ collectionId: v.id("knowledgeCollections"), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await requireOwnedThread(ctx, args.threadId, ctx.user.userId);

        const links = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
            .collect();

        await Promise.all(links.filter((link) => link.collectionId === args.collectionId).map((link) => ctx.db.delete(link._id)));

        ctx.log.event("knowledge.detach_collection", { scope: "thread" });

        return null;
    });

/** Collections attached to a thread, for anyone who may read it (as `getThreadKnowledge`). */
export const getThreadCollections = authQuery
    .input({ threadId: v.id("threads") })
    .output(v.array(vLinkedCollection))
    .query(async ({ args, ctx }) => {
        const { thread } = await requireThreadPermission(ctx, args.threadId, ctx.user.userId, "read");
        const links = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
            .collect();

        // Only the owner's links — a grantee cannot write one, but a stale row must not surface.
        return await describeLinks(
            ctx.db,
            links.filter((link) => link.userId === thread.userId),
            ctx.user.userId,
        );
    });

const requireOwnedProject = async (db: Db, projectId: Id<"projects">, userId: string): Promise<void> => {
    const project = await db.projects.findFirst({ where: { _id: projectId } });

    if (!project || project.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Project not found");
    }
};

export const attachCollectionToProject = authMutation
    .use(rateLimit("knowledge/add"))
    .input({ collectionId: v.id("knowledgeCollections"), projectId: v.id("projects") })
    .output(v.object({ alreadyAttached: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireOwnedProject(ctx.db, args.projectId, userId);
        await requireReadableCollection(ctx, args.collectionId);

        const existing = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
            .collect();

        if (existing.some((link) => link.collectionId === args.collectionId)) {
            return { alreadyAttached: true };
        }

        await ctx.db.insert("knowledgeCollectionLinks", { addedAt: ctx.now, collectionId: args.collectionId, projectId: args.projectId, userId });

        ctx.log.event("knowledge.attach_collection", { scope: "project" });

        return { alreadyAttached: false };
    });

export const detachCollectionFromProject = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({ collectionId: v.id("knowledgeCollections"), projectId: v.id("projects") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await requireOwnedProject(ctx.db, args.projectId, ctx.user.userId);

        const links = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
            .collect();

        await Promise.all(links.filter((link) => link.collectionId === args.collectionId).map((link) => ctx.db.delete(link._id)));

        ctx.log.event("knowledge.detach_collection", { scope: "project" });

        return null;
    });

export const getProjectCollections = authQuery
    .input({ projectId: v.id("projects") })
    .output(v.array(vLinkedCollection))
    .query(async ({ args, ctx }) => {
        await requireOwnedProject(ctx.db, args.projectId, ctx.user.userId);

        const links = await ctx.db
            .query("knowledgeCollectionLinks")
            .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
            .collect();

        return await describeLinks(ctx.db, links, ctx.user.userId);
    });

// ============================================================================
// Reading a collection's files — on the owner's shard
// ============================================================================

const vCollectionFile = v.object({
    _id: v.id("knowledgeFiles"),
    chunkCount: v.optional(v.number()),
    createdAt: v.number(),
    mimeType: v.string(),
    name: v.string(),
    relativePath: v.optional(v.string()),
    size: v.number(),
    sourceUrl: v.optional(v.string()),
    status: v.string(),
});

/** Whether `userId` belongs to `organizationId`, read from the global membership table. */
const isMember = async (ctx: { db: Db }, organizationId: string | null | undefined, userId: string): Promise<boolean> =>
    !!organizationId && (await getMemberByOrganizationAndUser(ctx as never, organizationId, userId)) !== null;

/**
 * The collection's files on THIS shard, when `requesterId` may read it: the
 * owner, or a member of the organization it is shared with. Internal — the
 * membership is re-checked here because a cross-shard caller only asserted it.
 */
export const listFilesInCollection = internalQuery
    .input({ collectionId: v.id("knowledgeCollections"), requesterId: v.string() })
    .output(v.union(v.null(), v.array(vCollectionFile)))
    .query(async ({ args, ctx }) => {
        const collection = await ctx.db.knowledgeCollections.findFirst({ where: { _id: args.collectionId } });

        if (!collection || (collection.userId !== args.requesterId && !(await isMember(ctx, collection.organizationId, args.requesterId)))) {
            return null;
        }

        const files = await ctx.db
            .query("knowledgeFiles")
            .withIndex("by_userId_collectionId", (q) => q.eq("userId", collection.userId).eq("collectionId", collection._id))
            .take(MAX_FILES_UNFILED_WITH_COLLECTION);

        return files.map((file) => {
            return {
                _id: file._id,
                chunkCount: file.chunkCount,
                createdAt: file.createdAt,
                mimeType: file.mimeType,
                name: file.name,
                relativePath: file.relativePath,
                size: file.size,
                sourceUrl: file.sourceUrl,
                status: file.status,
            };
        });
    });

/** Who owns a collection — for routing to their shard. No access decision. */
export const getCollectionOwner = internalQuery
    .input({ collectionId: v.id("knowledgeCollections") })
    .output(v.union(v.null(), v.string()))
    .query(async ({ args, ctx }) => {
        const collection = await ctx.db.knowledgeCollections.findFirst({ where: { _id: args.collectionId } });

        return collection?.userId ?? null;
    });

/**
 * A collection's files, for its owner or a member of the organization it is
 * shared with. An action because a shared collection's files are on the
 * owner's shard, which only an outbound shard call reaches.
 */
export const listCollectionFiles = authAction
    .use(rateLimit("knowledge/search"))
    .input({ collectionId: v.id("knowledgeCollections") })
    .output(v.array(vCollectionFile))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const ownerId = await ctx.runQuery(internal.knowledge.collections.getCollectionOwner, { collectionId: args.collectionId });
        const request = { collectionId: args.collectionId, requesterId: userId };
        let files: Infer<typeof vCollectionFile>[] | null = null;

        if (ownerId === userId) {
            files = await ctx.runQuery(internal.knowledge.collections.listFilesInCollection, request);
        } else if (ownerId !== null) {
            files = await callOnShard(internal.knowledge.collections.listFilesInCollection, request, { shardKey: ownerId });
        }

        if (!files) {
            throw new LunoraError("NOT_FOUND", "Collection not found");
        }

        ctx.log.event("knowledge.list_collection_files", { count: files.length, shared: ownerId !== userId });

        return files;
    });

// ============================================================================
// Retrieval scope
// ============================================================================

/**
 * What `knowledge_retrieve.search` searches for a thread — see `scope.ts`.
 * The user's own collections are resolved to their indexed files here; shared
 * collections owned by others come back per owner, for a search on that
 * owner's shard.
 */
export const resolveRetrievalScope = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(
        v.object({
            fileIds: v.array(v.string()),
            foreign: v.array(v.object({ collectionIds: v.array(v.string()), ownerId: v.string() })),
            hasExplicitScope: v.boolean(),
        }),
    )
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const thread = await ctx.db.get(threadId);
        const projectId = thread?.projectId ?? null;
        const [threadFileLinks, threadCollectionLinks, projectFileLinks, projectCollectionLinks] = await Promise.all([
            ctx.db
                .query("threadKnowledge")
                .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
                .collect(),
            ctx.db
                .query("knowledgeCollectionLinks")
                .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
                .collect(),
            projectId
                ? ctx.db
                      .query("projectKnowledge")
                      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
                      .collect()
                : Promise.resolve([]),
            projectId
                ? ctx.db
                      .query("knowledgeCollectionLinks")
                      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
                      .collect()
                : Promise.resolve([]),
        ]);
        const collectionIds = [...new Set([...threadCollectionLinks, ...projectCollectionLinks].map((link) => link.collectionId))];
        const [collections, memberships] = await Promise.all([
            collectionIds.length > 0
                ? ctx.db.knowledgeCollections.findMany({ where: { _id: { in: collectionIds } } }).then((result) => result.page)
                : Promise.resolve([]),
            collectionIds.length > 0 ? getMembersByUserId(ctx as never, userId) : Promise.resolve([]),
        ]);
        const plan = planRetrievalScope(
            {
                projectCollectionIds: projectCollectionLinks.map((link) => link.collectionId),
                projectFileIds: projectFileLinks.map((link) => link.knowledgeFileId),
                threadCollectionIds: threadCollectionLinks.map((link) => link.collectionId),
                threadFileIds: threadFileLinks.map((link) => link.knowledgeFileId),
            },
            collections,
            userId,
            new Set(memberships.map((member) => member.organizationId)),
        );
        const collectionFiles = await Promise.all(
            plan.ownCollectionIds.map(
                async (collectionId) =>
                    await ctx.db
                        .query("knowledgeFiles")
                        .withIndex("by_userId_collectionId", (q) => q.eq("userId", userId).eq("collectionId", collectionId as Id<"knowledgeCollections">))
                        .collect(),
            ),
        );
        const indexed = collectionFiles.flat().filter((file) => file.status === "indexed");

        return {
            fileIds: [...new Set([...plan.fileIds, ...indexed.map((file) => file._id as string)])],
            foreign: plan.foreign,
            hasExplicitScope: plan.hasExplicitScope,
        };
    });

/**
 * The indexed files behind shared collections on THIS (the owner's) shard,
 * for a member's search. Re-checks everything the caller's shard asserted:
 * each collection belongs to `ownerId`, is shared, and `requesterId` is a
 * member of its organization.
 */
export const resolveSharedCollectionFiles = internalQuery
    .input({ collectionIds: v.array(v.id("knowledgeCollections")), ownerId: v.string(), requesterId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        const fileIds: string[] = [];

        const collectionIds = new Set(args.collectionIds);

        for (const collectionId of collectionIds) {
            const collection = await ctx.db.knowledgeCollections.findFirst({ where: { _id: collectionId } });

            if (!collection || collection.userId !== args.ownerId || !(await isMember(ctx, collection.organizationId, args.requesterId))) {
                continue;
            }

            const files = await ctx.db
                .query("knowledgeFiles")
                .withIndex("by_userId_collectionId", (q) => q.eq("userId", args.ownerId).eq("collectionId", collectionId))
                .collect();

            fileIds.push(...files.filter((file) => file.status === "indexed").map((file) => file._id as string));
        }

        return fileIds;
    });
