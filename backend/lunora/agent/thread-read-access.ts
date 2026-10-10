import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx as ActionContext, QueryCtx as QueryContext } from "../_generated/server";
import { throwThreadNotFound } from "../lib/error-helpers";
import { admitThread, systemDb } from "../lib/rls/scope";

/**
 * Who may read a thread's raw message rows through a CLIENT-reachable procedure.
 *
 * The owner, or a member invited through `chat/sharing.ts` whose grant has not
 * expired. `isPublic` deliberately grants nothing here: the public surface of a
 * shared thread is `chat_sharing.getPublicThread`, keyed by the share token and
 * projected to an allow-list. Treating `isPublic` as a read grant on raw rows
 * let any signed-in caller holding a thread id read user ids, provider metadata
 * and tool payloads of every public thread.
 */
export interface ThreadReadAccessInput {
    /** The caller's `threadAccess` row for this thread, if any. */
    access: { expiresAt?: number } | null | undefined;
    now: number;
    thread: { userId?: string };
    userId: string;
}

export const hasThreadReadAccess = ({ access, now, thread, userId }: ThreadReadAccessInput): boolean => {
    if (thread.userId !== undefined && thread.userId === userId) {
        return true;
    }

    if (!access) {
        return false;
    }

    return access.expiresAt === undefined || access.expiresAt >= now;
};

/** Access level on a thread, weakest first. The owner is always `admin`. */
export type ThreadPermission = "admin" | "read" | "write";

const PERMISSION_LEVELS: Record<ThreadPermission, number> = { admin: 3, read: 1, write: 2 };

export const meetsThreadPermission = (granted: ThreadPermission, required: ThreadPermission): boolean =>
    PERMISSION_LEVELS[granted] >= PERMISSION_LEVELS[required];

/**
 * - `full` — owner (`admin`) or live grantee (the grant's permission): the raw row.
 * - `redacted` — a live PUBLIC thread and anyone else, including no caller at
 *   all: only what `redactThreadForPublicViewer` / `toPublicThreadMessages`
 *   let through. Never an authorization for anything but that projection.
 * - `null` — nothing, including a missing thread.
 */
export type ThreadReadAccess = { kind: "full"; permission: ThreadPermission; thread: Doc<"threads"> } | { kind: "redacted"; thread: Doc<"threads"> } | null;

/**
 * THE decision of who may read a thread. Every client-reachable read goes
 * through here, so the owner/grant/expiry/public rules exist once. A caller
 * that needs raw rows or authorizes a write accepts `full` only.
 *
 * Deleted threads are left to the caller (the owner's trash still reads them),
 * except that a deleted or temporary thread is never shown `redacted` — the
 * share page (`getPublicThread`) refuses both.
 */
export const resolveThreadReadAccess = async (
    context: Pick<QueryContext, "db">,
    threadId: Id<"threads">,
    userId: string | null | undefined,
): Promise<ThreadReadAccess> => {
    // The decision reads past row-level security (a grantee cannot see the
    // owner's row until it is admitted); the admission below is what then lets
    // the procedure's own reads of the thread and its rows through.
    const db = systemDb(context);
    const thread = await db.get(threadId);

    if (!thread) {
        return null;
    }

    if (userId) {
        if (thread.userId === userId) {
            admitThread(context, threadId, "admin", userId);

            return { kind: "full", permission: "admin", thread };
        }

        // `.global()` (D1): a grant is read from whichever shard the caller is on.
        const access = await context.db.threadAccess.findFirst({ where: { threadId, userId } });

        if (access && hasThreadReadAccess({ access, now: Date.now(), thread, userId })) {
            admitThread(context, threadId, access.permission, userId);

            return { kind: "full", permission: access.permission, thread };
        }
    }

    if (thread.isPublic === true && thread.deleted !== true && thread.isTemporary !== true) {
        admitThread(context, threadId, "public", userId ?? null);

        return { kind: "redacted", thread };
    }

    return null;
};

/*
 * The `require*` helpers below all fail the same way: `throwThreadNotFound`
 * (NOT_FOUND) for a thread the caller cannot reach as much as for a missing one,
 * so the answer is no oracle for which thread ids exist.
 */

/**
 * The caller must OWN the thread — not a grantee, whatever their permission.
 * For rows hung off a thread that only the owner manages (knowledge links,
 * thread variables, relationships): a grantee writing one would plant it in
 * someone else's thread.
 */
export const requireOwnedThread = async (context: Pick<QueryContext, "db">, threadId: Id<"threads">, userId: string): Promise<Doc<"threads">> => {
    const thread = await context.db.get(threadId);

    if (!thread || thread.userId !== userId) {
        return throwThreadNotFound();
    }

    admitThread(context, threadId, "admin", userId);

    return thread;
};

/**
 * The caller must hold at least `level` on the thread — the owner (always
 * `admin`) or a live grantee. A public thread's redacted view is not access.
 */
export const requireThreadPermission = async (
    context: Pick<QueryContext, "db">,
    threadId: Id<"threads">,
    userId: string,
    level: ThreadPermission,
): Promise<{ permission: ThreadPermission; thread: Doc<"threads"> }> => {
    const access = await resolveThreadReadAccess(context, threadId, userId);

    if (access?.kind !== "full" || !meetsThreadPermission(access.permission, level)) {
        return throwThreadNotFound();
    }

    return { permission: access.permission, thread: access.thread };
};

/**
 * The action form of {@link requireThreadPermission}: an action reaches the
 * database only through `runQuery`. Same rule, same error.
 */
export const requireThreadPermissionInAction = async (
    context: Pick<ActionContext, "runQuery">,
    threadId: Id<"threads">,
    userId: string,
    level: ThreadPermission,
): Promise<ThreadPermission> => {
    const access = await context.runQuery(internal.agent.threads.checkThreadAccessBatch, { requiredPermission: level, threadId, userId });

    if (!access.hasAccess) {
        return throwThreadNotFound();
    }

    return access.permission;
};

/**
 * What a PUBLIC thread shows a viewer who is neither owner nor grantee.
 *
 * An allow-list: identity, title, dates and the fields the thread page needs to
 * pick a renderer (`mode`, `model`). No owner id, system prompt, org/team/project
 * ids, tags or summary. `publicAccessToken` stays on purpose: the viewer can
 * already read the thread, and the web app uses it to move them to the
 * read-only `/thread/$token` page.
 */
type RedactedKey = "_creationTime" | "_id" | "mode" | "model" | "publicAccessToken" | "status" | "title" | "updatedAt";

export type RedactedThread<T extends Pick<ThreadLike, "_creationTime" | "_id" | "status">> = Pick<T, Extract<RedactedKey, keyof T>> & { isPublic: true };

interface ThreadLike {
    _creationTime: number;
    _id: string;
    status: string;
}

export const redactThreadForPublicViewer = <T extends Partial<Record<RedactedKey, unknown>> & ThreadLike>(thread: T): RedactedThread<T> => {
    const redacted: Record<string, unknown> = { isPublic: true };

    for (const key of ["_creationTime", "_id", "mode", "model", "publicAccessToken", "status", "title", "updatedAt"] as const) {
        if (thread[key] !== undefined && thread[key] !== null) {
            redacted[key] = thread[key];
        }
    }

    return redacted as RedactedThread<T>;
};

/**
 * Admits a thread the caller was just proven to OWN by an ad-hoc check
 * (`thread.userId !== userId → refuse`), for row-level security. Needed where
 * the procedure then reads the thread's rows: a write grantee's replies carry
 * the grantee's `userId`, and are the owner's to read only through the thread.
 */
export const admitOwnedThread = (context: unknown, thread: { _id: string; userId?: string }, userId: string): void => {
    if (thread.userId === userId) {
        admitThread(context, thread._id, "admin", userId);
    }
};
