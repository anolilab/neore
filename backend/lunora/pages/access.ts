/**
 * Who may do what on a page — THE decision, so the owner/grant rules exist once.
 *
 * Mirrors `agent/thread-read-access.ts`: the owner is `admin`; anyone else needs
 * a `pageAccess` grant, and gets exactly its permission. `isPublic` grants
 * NOTHING here — the public surface is `pages_functions.getPublicPage`, keyed by
 * the share token and projected to an allow-list. A page that exists but is not
 * the caller's answers the same as a missing one (`null`), so ids cannot be
 * probed.
 */
import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { admitPage, systemDb } from "../lib/rls/scope";
import type { PagePermission } from "./logic";
import { meetsPagePermission } from "./logic";

export type PageAccess = { page: Doc<"pages">; permission: PagePermission } | null;

/** The grant decision with the rows already loaded — what `access.test.ts` pins. */
export const permissionFor = (page: { userId: string }, grant: { permission: PagePermission } | null | undefined, userId: string): PagePermission | null => {
    if (page.userId === userId) {
        return "admin";
    }

    return grant ? grant.permission : null;
};

export const resolvePageAccess = async (ctx: Pick<QueryCtx, "db">, pageId: Id<"pages">, userId: string | null | undefined): Promise<PageAccess> => {
    if (!userId) {
        return null;
    }

    // Decided past row-level security, then admitted for the caller — see
    // `resolveThreadReadAccess`. `acceptPageInvite` asks about the INVITER; a
    // decision about someone else admits nothing.
    const db = systemDb(ctx);
    const page = await db.get(pageId);

    if (!page) {
        return null;
    }

    // `pageAccess` is `.global()` (D1): read from whichever shard the caller is on.
    const grant = page.userId === userId ? null : await ctx.db.pageAccess.findFirst({ where: { pageId, userId } });

    const permission = permissionFor(page, grant, userId);

    if (permission) {
        admitPage(ctx, pageId, permission, userId);
    }

    return permission ? { page, permission } : null;
};

/**
 * Resolves access like {@link resolvePageAccess}, requiring at least
 * `required`. A caller with no access at all gets NOT_FOUND; one with too
 * little gets FORBIDDEN — they can already see the page exists.
 */
export const requirePageAccess = async (
    ctx: Pick<QueryCtx, "db">,
    pageId: Id<"pages">,
    userId: string,
    required: PagePermission,
): Promise<{ page: Doc<"pages">; permission: PagePermission }> => {
    const access = await resolvePageAccess(ctx, pageId, userId);

    if (!access) {
        throw new LunoraError("NOT_FOUND", "Page not found");
    }

    if (!meetsPagePermission(access.permission, required)) {
        throw new LunoraError("FORBIDDEN", "You do not have permission to do that on this page");
    }

    return access;
};

/** Structural operations — the tree, favorites, delete — belong to the owner alone. */
export const requireOwnedPage = async (ctx: Pick<QueryCtx, "db">, pageId: Id<"pages">, userId: string): Promise<Doc<"pages">> => {
    const page = await ctx.db.get(pageId);

    if (!page || page.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Page not found");
    }

    admitPage(ctx, pageId, "admin", userId);

    return page;
};

/**
 * Admits the pages behind the caller's own `pageAccess` rows. The rows are read
 * through `ctx.db`, so row-level security has already limited them to grants
 * held by the caller — each one IS the proof of access.
 */
export const admitGrantedPages = (ctx: unknown, grants: ReadonlyArray<Pick<Doc<"pageAccess">, "pageId" | "permission" | "userId">>): void => {
    for (const grant of grants) {
        admitPage(ctx, grant.pageId, grant.permission, grant.userId);
    }
};
