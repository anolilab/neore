/**
 * Pages — Notion-style documents: a per-user page tree, favorites, search,
 * content saves with grouped version history, and restore.
 *
 * Content is TipTap JSON (`contentJson`), the same form the canvas text editor
 * writes, plus the editor's markdown (`content`) for the Page agent and a plain
 * `searchText` for search. Every content write goes through {@link writeContent},
 * which reconciles comment anchors (`comment-anchors.ts`) and records the
 * version snapshot (`logic.ts#snapshotAction`) — so a save, a restore and an
 * agent edit cannot drift apart.
 *
 * Access: the TREE (move, favorite, delete) is the owner's alone; content and
 * title follow `pageAccess` grants (`access.ts`). Sharing lives in `sharing.ts`,
 * comments in `comments.ts`, presence in `presence.ts`.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { parentKeyOf, systemDb } from "../lib/rls/scope";
import { requireOwnedPage, requirePageAccess } from "./access";
import { collectCommentAnchors, reconcileCommentAnchors, removeCommentMarks, sameContentIgnoringComments } from "./comment-anchors";
import type { VersionReason } from "./logic";
import {
    collectSubtree,
    extractPlainText,
    isRevisionConflict,
    MAX_PAGES_PER_USER,
    MAX_SUBTREE_DELETE,
    MAX_VERSIONS_PER_PAGE,
    orderBetween,
    orderForIndex,
    PAGE_CONTENT_MAX,
    PAGE_REVISION_CONFLICT,
    PAGE_TITLE_MAX,
    searchSnippet,
    snapshotAction,
    wouldCreateCycle,
} from "./logic";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonValue } from "../lib/validators";

const MAX_SEARCH_RESULTS = 20;
const SEARCH_QUERY_MAX = 200;
const MAX_BREADCRUMB_DEPTH = 20;
const ICON_MAX = 16;

/** The search index is a prefix of the plain text — enough to find a page, bounded per row. */
const SEARCH_TEXT_MAX = 20_000;

export const vPagePermission = v.union(v.literal("read"), v.literal("comment"), v.literal("write"), v.literal("admin"));

// ─── Output shapes ───────────────────────────────────────────────────────────

const vPageTree = v.object({
    owned: v.array(
        v.object({
            _id: v.id("pages"),
            icon: v.union(v.string(), v.null()),
            isFavorite: v.boolean(),
            isPublic: v.boolean(),
            order: v.number(),
            parentPageId: v.union(v.id("pages"), v.null()),
            title: v.string(),
            updatedAt: v.number(),
        }),
    ),
    shared: v.array(
        v.object({
            _id: v.id("pages"),
            icon: v.union(v.string(), v.null()),
            isFavorite: v.boolean(),
            permission: vPagePermission,
            title: v.string(),
            updatedAt: v.number(),
        }),
    ),
});

const vPageDetail = v.object({
    _id: v.id("pages"),
    breadcrumbs: v.array(v.object({ _id: v.id("pages"), title: v.string() })),
    content: v.union(v.string(), v.null()),
    contentJson: v.optional(v.any()),
    icon: v.union(v.string(), v.null()),
    isFavorite: v.boolean(),
    isOwner: v.boolean(),
    isPublic: v.boolean(),
    permission: vPagePermission,
    revision: v.number(),
    title: v.string(),
    updatedAt: v.number(),
});

const vVersionSummary = v.object({
    _id: v.id("pageVersions"),
    createdAt: v.number(),
    isOwnEdit: v.boolean(),
    reason: v.union(v.literal("edit"), v.literal("agent"), v.literal("restore")),
    title: v.string(),
    updatedAt: v.number(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const loadOwnedPages = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Doc<"pages">[]> =>
    await ctx.db
        .query("pages")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(MAX_PAGES_PER_USER);

/** The pages shared WITH `userId` — `pageAccess` is `.global()`, so readable from their own shard. */
const loadGrantsOf = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Doc<"pageAccess">[]> => {
    const { page } = await ctx.db.pageAccess.findMany({ limit: MAX_PAGES_PER_USER, orderBy: [{ pageId: "asc" }], where: { userId } });

    return page;
};

/** Whether `userId` has starred `pageId`: their own star row, or — on a page shared with them — their grant. */
const isStarred = async (ctx: Pick<QueryCtx, "db">, page: Doc<"pages">, userId: string): Promise<boolean> => {
    if (page.userId === userId) {
        return (await loadFavorite(ctx, userId, page._id)) !== null;
    }

    const grant = await ctx.db.pageAccess.findFirst({ where: { pageId: page._id, userId } });

    return grant?.favoritedAt !== undefined;
};

const loadFavorite = async (ctx: Pick<QueryCtx, "db">, userId: string, pageId: Id<"pages">): Promise<Doc<"pageFavorites"> | null> =>
    await ctx.db
        .query("pageFavorites")
        .withIndex("by_user_and_page", (q) => q.eq("userId", userId).eq("pageId", pageId))
        .first();

const loadFavoriteIds = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Set<string>> => {
    const rows = await ctx.db
        .query("pageFavorites")
        .withIndex("by_user_and_page", (q) => q.eq("userId", userId))
        .take(MAX_PAGES_PER_USER);

    return new Set(rows.map((row) => row.pageId));
};

const requireTitle = (title: string): string => {
    const trimmed = title.trim();

    if (trimmed.length > PAGE_TITLE_MAX) {
        throw new LunoraError("BAD_REQUEST", `Title must be under ${String(PAGE_TITLE_MAX)} characters`);
    }

    return trimmed;
};

const requireIcon = (icon: string | null | undefined): string | undefined => {
    if (icon === null || icon === undefined || icon.trim() === "") {
        return undefined;
    }

    if (icon.length > ICON_MAX) {
        throw new LunoraError("BAD_REQUEST", "Icon is too long");
    }

    return icon;
};

const siblingOrders = (pages: ReadonlyArray<Doc<"pages">>, parentPageId: Id<"pages"> | undefined, excludeId?: Id<"pages">): number[] =>
    pages
        .filter((page) => (page.parentPageId ?? undefined) === parentPageId && page._id !== excludeId)
        .map((page) => page.order)
        .toSorted((a, b) => a - b);

/**
 * Refuses a write based on a stale revision with a coded CONFLICT whose data
 * carries the page as it is now, so the client can offer reload or overwrite.
 */
export const assertFreshRevision = (page: Doc<"pages">, baseRevision: number): void => {
    if (!isRevisionConflict(page, baseRevision)) {
        return;
    }

    throw new LunoraError("CONFLICT", "This page changed while you were editing", {
        data: {
            code: PAGE_REVISION_CONFLICT,
            content: page.content ?? "",
            contentJson: page.contentJson ?? null,
            revision: page.revision,
            title: page.title,
        },
    });
};

/**
 * The one content write.
 *
 * 1. Refuses a stale `baseRevision` (`assertFreshRevision`). `null` means a
 *    server-side write derived from the stored page in this same transaction.
 * 2. Strips marks of comment threads that no longer exist (`keepCommentIds`
 *    spares the editor's unsaved draft), then re-anchors or orphans the open
 *    threads (`comment-anchors.ts`).
 * 3. Writes the page, bumping `revision` always and `contentRevision` only for
 *    a real content change, and records the version snapshot.
 *
 * Returns the stored document when steps 2 changed it, so the editor can adopt
 * it; `null` otherwise.
 */
export const writeContent = async (
    ctx: MutationCtx,
    page: Doc<"pages">,
    input: {
        authorId: string;
        baseRevision: number | null;
        content: string | undefined;
        contentJson: unknown;
        keepCommentIds?: ReadonlyArray<string>;
        reason: VersionReason;
        title?: string;
    },
): Promise<{ contentJson: unknown; revision: number }> => {
    const serialized = JSON.stringify(input.contentJson ?? null);

    if (serialized.length > PAGE_CONTENT_MAX) {
        throw new LunoraError("BAD_REQUEST", "This page is too large to save");
    }

    if (input.baseRevision !== null) {
        assertFreshRevision(page, input.baseRevision);
    }

    const now = Date.now();
    const comments = await ctx.db
        .query("pageComments")
        .withIndex("by_page_and_created", (q) => q.eq("pageId", page._id))
        .collect();
    const threadIds = new Set([
        ...comments.filter((comment) => comment.parentId === undefined).map((comment) => comment.commentId),
        ...(input.keepCommentIds ?? []),
    ]);
    let deadMarks = false;

    for (const id of collectCommentAnchors(input.contentJson).keys()) {
        deadMarks ||= !threadIds.has(id);
    }

    const cleaned = deadMarks ? removeCommentMarks(input.contentJson, (id) => id === undefined || !threadIds.has(id)) : input.contentJson;
    const openRoots = comments.filter((comment) => comment.parentId === undefined && comment.status === "open");

    const { doc, outcomes } = reconcileCommentAnchors(
        cleaned,
        openRoots.map((comment) => {
            return { anchorText: comment.anchorText ?? "", commentId: comment.commentId, orphaned: comment.orphaned === true };
        }),
    );

    for (const outcome of outcomes) {
        const row = openRoots.find((comment) => comment.commentId === outcome.commentId);

        if (!row) {
            continue;
        }

        if (outcome.kind === "orphaned") {
            if (row.orphaned !== true) {
                await ctx.db.patch(row._id, { orphaned: true });
            }
        } else if (row.orphaned === true || row.anchorText !== outcome.anchorText) {
            await patchRow(ctx.db, row, { anchorText: outcome.anchorText, orphaned: undefined });
        }
    }

    const title = input.title ?? page.title;
    const changed = title !== page.title || !sameContentIgnoringComments(page.contentJson, doc);
    const revision = page.revision + 1;

    await ctx.db.patch(
        page._id,
        withoutUndefined({
            content: input.content ?? page.content ?? "",
            contentJson: doc ?? undefined,
            contentRevision: changed ? revision : page.contentRevision,
            lastEditedBy: input.authorId,
            revision,
            searchText: extractPlainText(doc).slice(0, SEARCH_TEXT_MAX),
            title,
            updatedAt: now,
        }),
    );

    // Comment marks alone (a comment added or removed) are not a new version.
    if (changed || input.reason !== "edit") {
        await recordSnapshot(ctx, page._id, {
            authorId: input.authorId,
            content: input.content,
            contentJson: doc,
            now,
            reason: input.reason,
            title,
        });
    }

    return { contentJson: doc === input.contentJson ? null : doc, revision };
};

const recordSnapshot = async (
    ctx: MutationCtx,
    pageId: Id<"pages">,
    input: { authorId: string; content: string | undefined; contentJson: unknown; now: number; reason: VersionReason; title: string },
): Promise<void> => {
    const latest = await ctx.db
        .query("pageVersions")
        .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
        .order("desc")
        .first();

    const action = snapshotAction(latest ? { authorId: latest.userId, createdAt: latest.createdAt, reason: latest.reason } : null, {
        authorId: input.authorId,
        now: input.now,
        reason: input.reason,
    });

    if (action === "update" && latest) {
        await ctx.db.patch(
            latest._id,
            withoutUndefined({
                content: input.content ?? "",
                contentJson: input.contentJson ?? undefined,
                title: input.title,
                updatedAt: input.now,
            }),
        );

        return;
    }

    await ctx.db.insert("pageVersions", {
        content: input.content ?? "",
        contentJson: input.contentJson,
        createdAt: input.now,
        pageId,
        reason: input.reason,
        title: input.title,
        updatedAt: input.now,
        userId: input.authorId,
    });

    // Prune past the cap, oldest first. Bounded: at most one row over per insert.
    const overflow = await ctx.db
        .query("pageVersions")
        .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
        .order("desc")
        .take(MAX_VERSIONS_PER_PAGE + 5);

    for (const row of overflow.slice(MAX_VERSIONS_PER_PAGE)) {
        await ctx.db.delete(row._id);
    }
};

/** Everything hanging off one page, deleted with it. */
export const deletePageRows = async (ctx: MutationCtx, pageId: Id<"pages">): Promise<void> => {
    const [comments, versions, grants, invites, presence, favorites] = await Promise.all([
        ctx.db
            .query("pageComments")
            .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
            .collect(),
        ctx.db
            .query("pageVersions")
            .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
            .collect(),
        // Grants and invites are `.global()`: every collaborator's, from any shard.
        ctx.db.pageAccess.findMany({ where: { pageId } }).then((result) => result.page),
        ctx.db.pageInvites.findMany({ where: { pageId } }).then((result) => result.page),
        ctx.db
            .query("pagePresence")
            .withIndex("by_page", (q) => q.eq("pageId", pageId))
            .collect(),
        ctx.db
            .query("pageFavorites")
            .withIndex("by_page", (q) => q.eq("pageId", pageId))
            .collect(),
    ]);

    // Replies before roots, so no reply is ever left pointing at a deleted root.
    const orderedComments = comments.toSorted((a, b) => Number(a.parentId === undefined) - Number(b.parentId === undefined));

    for (const row of [...orderedComments, ...versions, ...grants, ...invites, ...presence, ...favorites]) {
        await ctx.db.delete(row._id);
    }

    await ctx.db.delete(pageId);
};

// ─── Reads ───────────────────────────────────────────────────────────────────

export const listPageTree = authQuery
    .input({})
    .output(v.from(vPageTree))
    .query(async ({ ctx }): Promise<Infer<typeof vPageTree>> => {
        const { userId } = ctx.user;
        const [owned, grants, favorites] = await Promise.all([loadOwnedPages(ctx, userId), loadGrantsOf(ctx, userId), loadFavoriteIds(ctx, userId)]);

        return {
            owned: owned.map((page) => {
                return {
                    _id: page._id,
                    icon: page.icon ?? null,
                    isFavorite: favorites.has(page._id),
                    isPublic: page.isPublic === true,
                    order: page.order,
                    parentPageId: page.parentPageId ?? null,
                    title: page.title,
                    updatedAt: page.updatedAt,
                };
            }),
            // A shared page lives on its OWNER's shard, which this query (on the
            // caller's) cannot read — so the sidebar entry comes from the grant,
            // which carries the title, icon and the caller's star.
            shared: grants.map((grant) => {
                return {
                    _id: grant.pageId,
                    icon: grant.icon ?? null,
                    isFavorite: grant.favoritedAt !== undefined,
                    permission: grant.permission,
                    title: grant.title ?? "",
                    updatedAt: grant.grantedAt,
                };
            }),
        };
    });

export const getPage = authQuery
    .input({ pageId: v.id("pages") })
    .output(v.from(vPageDetail))
    .query(async ({ args: { pageId }, ctx }): Promise<Infer<typeof vPageDetail>> => {
        const { page, permission } = await requirePageAccess(ctx, pageId, ctx.user.userId, "read");
        const isOwner = page.userId === ctx.user.userId;

        // Breadcrumbs only for the owner: a grantee was shared THIS page, not its ancestors.
        const breadcrumbs: { _id: Id<"pages">; title: string }[] = [];

        if (isOwner) {
            let cursor = page.parentPageId;

            while (cursor && breadcrumbs.length < MAX_BREADCRUMB_DEPTH) {
                const ancestor = await ctx.db.get(cursor);

                if (!ancestor || ancestor.userId !== page.userId) {
                    break;
                }

                breadcrumbs.unshift({ _id: ancestor._id, title: ancestor.title });
                cursor = ancestor.parentPageId;
            }
        }

        return {
            _id: page._id,
            breadcrumbs,
            content: page.content ?? null,
            contentJson: page.contentJson ?? undefined,
            icon: page.icon ?? null,
            isFavorite: await isStarred(ctx, page, ctx.user.userId),
            isOwner,
            isPublic: page.isPublic === true,
            permission,
            revision: page.revision,
            title: page.title,
            updatedAt: page.updatedAt,
        };
    });

export const searchPages = authQuery
    .input({ query: v.string().max(MAX_LENGTH.long) })
    .output(v.array(v.object({ _id: v.id("pages"), snippet: v.union(v.string(), v.null()), title: v.string() })))
    .query(async ({ args, ctx }) => {
        const query = args.query.trim().slice(0, SEARCH_QUERY_MAX).toLowerCase();

        if (query.length === 0) {
            return [];
        }

        const { userId } = ctx.user;
        const [owned, grants] = await Promise.all([loadOwnedPages(ctx, userId), loadGrantsOf(ctx, userId)]);
        // A shared page's content lives on its owner's shard; from the caller's
        // shard only its title (copied onto the grant) is searchable.
        const shared = grants.map((grant) => {
            return { _id: grant.pageId, searchText: undefined, title: grant.title ?? "", updatedAt: grant.grantedAt };
        });
        const candidates = [...owned, ...shared].toSorted((a, b) => b.updatedAt - a.updatedAt);

        const results: { _id: Id<"pages">; snippet: string | null; title: string }[] = [];

        for (const page of candidates) {
            const inTitle = page.title.toLowerCase().includes(query);
            const snippet = searchSnippet(page.searchText ?? "", query);

            if (inTitle || snippet) {
                results.push({ _id: page._id, snippet, title: page.title });
            }

            if (results.length >= MAX_SEARCH_RESULTS) {
                break;
            }
        }

        return results;
    });

export const listPageVersions = authQuery
    .input({ pageId: v.id("pages") })
    .output(v.array(vVersionSummary))
    .query(async ({ args: { pageId }, ctx }) => {
        await requirePageAccess(ctx, pageId, ctx.user.userId, "read");

        const versions = await ctx.db
            .query("pageVersions")
            .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
            .order("desc")
            .take(MAX_VERSIONS_PER_PAGE);

        return versions.map((version) => {
            return {
                _id: version._id,
                createdAt: version.createdAt,
                isOwnEdit: version.userId === ctx.user.userId,
                reason: version.reason,
                title: version.title,
                updatedAt: version.updatedAt,
            };
        });
    });

export const getPageVersion = authQuery
    .input({ versionId: v.id("pageVersions") })
    .output(v.object({ _id: v.id("pageVersions"), contentJson: v.optional(v.any()), createdAt: v.number(), title: v.string() }))
    .query(async ({ args: { versionId }, ctx }) => {
        const pageId = await parentKeyOf(ctx, versionId, "pageId");

        if (!pageId) {
            throw new LunoraError("NOT_FOUND", "Version not found");
        }

        await requirePageAccess(ctx, pageId as Id<"pages">, ctx.user.userId, "read");

        const version = await ctx.db.get(versionId);

        if (!version) {
            throw new LunoraError("NOT_FOUND", "Version not found");
        }

        return { _id: version._id, contentJson: version.contentJson ?? undefined, createdAt: version.createdAt, title: version.title };
    });

// ─── Tree writes ─────────────────────────────────────────────────────────────

export const createPage = authMutation
    .use(rateLimit("pages/create"))
    .input({
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        parentPageId: v.optional(v.id("pages")),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.object({ pageId: v.id("pages") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const owned = await loadOwnedPages(ctx, userId);

        if (owned.length >= MAX_PAGES_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_PAGES_PER_USER)} pages`);
        }

        if (args.parentPageId) {
            await requireOwnedPage(ctx, args.parentPageId, userId);
        }

        const orders = siblingOrders(owned, args.parentPageId);
        const now = ctx.now;
        const pageId = await ctx.db.insert("pages", {
            contentRevision: 0,
            createdAt: now,
            icon: requireIcon(args.icon),
            order: orderBetween(orders.at(-1), undefined),
            parentPageId: args.parentPageId,
            revision: 0,
            title: requireTitle(args.title ?? ""),
            updatedAt: now,
            userId,
        });

        ctx.log.event("pages.create_page", { hasParent: args.parentPageId !== undefined });

        return { pageId };
    });

export const renamePage = authMutation
    .use(rateLimit("pages/update"))
    .input({
        icon: v.optional(v.union(v.string().max(MAX_LENGTH.url), v.null())),
        pageId: v.id("pages"),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { page } = await requirePageAccess(ctx, args.pageId, ctx.user.userId, "write");

        await patchRow(ctx.db, page, {
            ...(args.title !== undefined && { title: requireTitle(args.title) }),
            // `null` clears the icon; `patchRow` removes a key set to `undefined`.
            ...(args.icon !== undefined && { icon: requireIcon(args.icon) }),
            lastEditedBy: ctx.user.userId,
            updatedAt: ctx.now,
        });

        // Keep the grantees' sidebar copies (see `listPageTree`) in step.
        if (args.title !== undefined || args.icon !== undefined) {
            await syncGrantDisplay(ctx, page._id, {
                icon: args.icon === undefined ? page.icon : requireIcon(args.icon),
                title: args.title === undefined ? page.title : requireTitle(args.title),
            });
        }

        ctx.log.event("pages.rename_page", { hasIcon: args.icon !== undefined, hasTitle: args.title !== undefined });

        return null;
    });

/** Copy a page's title and icon onto every grant of it (`pageAccess`, `.global()`). */
export const syncGrantDisplay = async (
    ctx: Pick<MutationCtx, "db">,
    pageId: Id<"pages">,
    display: { icon: string | undefined; title: string },
): Promise<void> => {
    // Past row-level security: a WRITE collaborator may rename the page, and
    // only an admin may update its grants — but this copies nothing else.
    const db = systemDb(ctx);
    const { page: grants } = await db.pageAccess.findMany({ where: { pageId } });

    for (const grant of grants) {
        await patchRow(db, grant, { icon: display.icon, title: display.title });
    }
};

/**
 * Move a page under `parentPageId` (`null` = the top level) at `index` among
 * its new siblings. Refuses a move into the page's own subtree.
 */
export const movePage = authMutation
    .use(rateLimit("pages/update"))
    .input({
        index: v.number(),
        pageId: v.id("pages"),
        parentPageId: v.union(v.id("pages"), v.null()),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const page = await requireOwnedPage(ctx, args.pageId, userId);
        const owned = await loadOwnedPages(ctx, userId);
        const parentPageId = args.parentPageId ?? undefined;

        if (parentPageId && owned.every((candidate) => candidate._id !== parentPageId)) {
            throw new LunoraError("NOT_FOUND", "Parent page not found");
        }

        const parentOf = new Map<string, string | undefined>(owned.map((candidate) => [candidate._id, candidate.parentPageId ?? undefined]));

        if (wouldCreateCycle(page._id, parentPageId, parentOf)) {
            throw new LunoraError("BAD_REQUEST", "A page cannot be moved inside itself");
        }

        const order = orderForIndex(siblingOrders(owned, parentPageId, page._id), Math.floor(args.index));

        await patchRow(ctx.db, page, { order, parentPageId });

        ctx.log.event("pages.move_page", { index: Math.floor(args.index) });

        return null;
    });

export const setPageFavorite = authMutation
    .use(rateLimit("pages/update"))
    .input({ isFavorite: v.boolean(), pageId: v.id("pages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        // Anyone who can open a page may star it; the star is theirs alone.
        const { page } = await requirePageAccess(ctx, args.pageId, userId, "read");

        // A grantee's star lives on their grant — this runs on the OWNER's shard,
        // and their sidebar reads the grant from their own (`listPageTree`).
        if (page.userId !== userId) {
            const grant = await ctx.db.pageAccess.findFirst({ where: { pageId: args.pageId, userId } });

            // Past row-level security: a grantee may not update their grant (that
            // would let them raise its permission), but this writes only the star.
            if (grant) {
                await patchRow(systemDb(ctx), grant, { favoritedAt: args.isFavorite ? (grant.favoritedAt ?? ctx.now) : undefined });
            }

            ctx.log.event("pages.set_page_favorite", { isFavorite: args.isFavorite, isGrant: true });

            return null;
        }

        const existing = await loadFavorite(ctx, userId, args.pageId);

        if (args.isFavorite && !existing) {
            await ctx.db.insert("pageFavorites", { createdAt: ctx.now, pageId: args.pageId, userId });
        } else if (!args.isFavorite && existing) {
            await ctx.db.delete(existing._id);
        }

        ctx.log.event("pages.set_page_favorite", { isFavorite: args.isFavorite, isGrant: false });

        return null;
    });

/** Deletes the page and its whole subtree, with every comment, version, grant and invite. */
export const deletePage = authMutation
    .use(rateLimit("pages/delete"))
    .input({ pageId: v.id("pages") })
    .output(v.object({ deleted: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireOwnedPage(ctx, args.pageId, userId);

        const owned = await loadOwnedPages(ctx, userId);
        const childrenOf = new Map<string, string[]>();

        for (const page of owned) {
            if (page.parentPageId) {
                childrenOf.set(page.parentPageId, [...(childrenOf.get(page.parentPageId) ?? []), page._id]);
            }
        }

        const subtree = collectSubtree(args.pageId, childrenOf);

        if (subtree.length > MAX_SUBTREE_DELETE) {
            throw new LunoraError("BAD_REQUEST", `This page has more than ${String(MAX_SUBTREE_DELETE)} sub-pages; delete some of them first`);
        }

        // Deepest first, so a failure part-way never leaves a child whose parent is gone.
        for (const pageId of subtree.toReversed()) {
            await deletePageRows(ctx, pageId as Id<"pages">);
        }

        ctx.log.event("pages.delete_page", { deleted: subtree.length });

        return { deleted: subtree.length };
    });

// ─── Content ─────────────────────────────────────────────────────────────────

/**
 * The editor's autosave, and the Page agent's apply (`reason: "agent"`, which
 * always gets its own version). `baseRevision` is the revision the editor's
 * content derives from; a stale one is a coded CONFLICT (`assertFreshRevision`),
 * and "overwrite" is simply a second save based on the revision that conflict
 * reported. `draftCommentId` spares the mark of a comment being written.
 * Answers with the stored document when its comment marks had to be changed.
 */
export const savePageContent = authMutation
    .use(rateLimit("pages/save"))
    .input({
        baseRevision: v.number(),
        content: v.optional(v.string().max(MAX_LENGTH.document)),
        contentJson: v.optional(vJsonValue),
        draftCommentId: v.optional(v.string().max(MAX_LENGTH.id)),
        pageId: v.id("pages"),
        reason: v.optional(v.union(v.literal("edit"), v.literal("agent"))),
    })
    .output(v.object({ contentJson: v.optional(v.any()), revision: v.number() }))
    .mutation(async ({ args, ctx }) => {
        assertJsonWithinLimit(args.contentJson, "contentJson");
        const { page } = await requirePageAccess(ctx, args.pageId, ctx.user.userId, "write");

        if (args.content !== undefined && args.content.length > PAGE_CONTENT_MAX) {
            throw new LunoraError("BAD_REQUEST", "This page is too large to save");
        }

        const result = await writeContent(ctx, page, {
            authorId: ctx.user.userId,
            baseRevision: args.baseRevision,
            content: args.content,
            contentJson: args.contentJson,
            keepCommentIds: args.draftCommentId ? [args.draftCommentId] : [],
            reason: args.reason ?? "edit",
        });

        ctx.log.event("pages.save_page_content", { hasContentJson: args.contentJson !== undefined, revision: result.revision });

        return { contentJson: result.contentJson ?? undefined, revision: result.revision };
    });

export const restorePageVersion = authMutation
    .use(rateLimit("pages/update"))
    .input({ baseRevision: v.number(), versionId: v.id("pageVersions") })
    .output(v.object({ revision: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const pageId = await parentKeyOf(ctx, args.versionId, "pageId");

        if (!pageId) {
            throw new LunoraError("NOT_FOUND", "Version not found");
        }

        const { page } = await requirePageAccess(ctx, pageId as Id<"pages">, ctx.user.userId, "write");
        const version = await ctx.db.get(args.versionId);

        if (!version) {
            throw new LunoraError("NOT_FOUND", "Version not found");
        }

        const result = await writeContent(ctx, page, {
            authorId: ctx.user.userId,
            baseRevision: args.baseRevision,
            content: version.content,
            contentJson: version.contentJson,
            reason: "restore",
            title: version.title,
        });

        ctx.log.event("pages.restore_page_version", { revision: result.revision });

        return { revision: result.revision };
    });

/** "Open as page": copies a canvas text artifact into a new top-level page. */
export const createPageFromDocument = authMutation
    .use(rateLimit("pages/create"))
    .input({ documentId: v.id("documents") })
    .output(v.object({ pageId: v.id("pages") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const document = await ctx.db.get(args.documentId);

        if (!document || document.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Document not found");
        }

        if (document.kind !== "text") {
            throw new LunoraError("BAD_REQUEST", "Only text documents can be opened as a page");
        }

        const owned = await loadOwnedPages(ctx, userId);

        if (owned.length >= MAX_PAGES_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_PAGES_PER_USER)} pages`);
        }

        const now = ctx.now;
        const contentJson: unknown = document.contentJson ?? undefined;

        const pageId = await ctx.db.insert("pages", {
            content: document.content ?? "",
            contentJson,
            contentRevision: 0,
            createdAt: now,
            order: orderBetween(siblingOrders(owned, undefined).at(-1), undefined),
            revision: 0,
            searchText: (contentJson ? extractPlainText(contentJson) : (document.content ?? "")).slice(0, SEARCH_TEXT_MAX),
            sourceDocumentId: document._id,
            title: requireTitle(document.title).slice(0, PAGE_TITLE_MAX),
            updatedAt: now,
            userId,
        });

        ctx.log.event("pages.create_page_from_document", { documentKind: document.kind });

        return { pageId };
    });
