/**
 * The session helpers for procedures that need the caller's session row.
 *
 * Resolving the caller takes an identity token, then loading the better-auth
 * `session` and `user` rows. Lunora resolves identity in the
 * worker and hands it to every procedure as `ctx.auth`, so most of that work is
 * already done — but the shape differs, and ~70 call sites read
 * `identity.userId` / `.sessionId` / `.email` / `.name` / `.pictureUrl`. These
 * keep that shape.
 *
 * The one thing Lunora does NOT carry on `ctx.auth` is the raw request headers,
 * which `auth.api.*` calls need in order to act as the signed-in user. Those come
 * from the session row's token, reconstructed in {@link getHeaders}.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../_generated/server";

/** The caller, in the shape the session helpers expose. */
export interface AuthUserIdentity {
    email?: string;
    name?: string;
    pictureUrl?: string;
    sessionId: Id<"session">;
    /** better-auth's opaque subject — the same value as `userId`. */
    subject: string;
    userId: Id<"user">;
}

/**
 * A context that can read. Deliberately structural: this is called from queries,
 * mutations and the agent's `ToolCtx`, which do not share a nominal base type.
 */
type ReadContext = Pick<QueryContext, "auth" | "db">;

/** The caller's `session` row, or `null` when anonymous. */
export const getSession = async (context: ReadContext, sessionIdOverride?: string): Promise<Doc<"session"> | null> => {
    // `getIdentity()`, not `.identity`. Lunora's `AuthState` exposes the claims
    // through an async call (`getIdentity: () => Promise<Record<string, unknown> |
    // null>`). Reading a property that does not exist left `sessionId` undefined,
    // so `getSession` always returned null.
    // Callers that have already read the identity pass its `sessionId` in rather
    // than paying for a second `getIdentity()`. Two of them did, against a
    // one-parameter signature.
    // The identity read is hoisted out of the `??` chain rather than awaited
    // inline: `sessionIdOverride` is `string | undefined`, so this still skips
    // `getIdentity()` exactly when the caller supplied an id.
    const identity = sessionIdOverride === undefined ? await context.auth.getIdentity() : undefined;
    const sessionId = sessionIdOverride ?? identity?.sessionId;

    if (typeof sessionId !== "string") {
        return null;
    }

    return await context.db.session.findFirst({ where: { _id: sessionId as Id<"session"> } });
};

/** The caller's user id, or `null` when anonymous. */
export const getAuthUserId = (context: ReadContext): Id<"user"> | null => (context.auth.userId as Id<"user"> | null) ?? null;

/**
 * The caller's identity, or `null` when anonymous.
 *
 * Reads the `user` row rather than trusting the token's claims for the profile
 * fields: a token minted before a profile edit still carries the old name and
 * avatar, and these values are rendered.
 */
export const getAuthUserIdentity = async (context: ReadContext): Promise<AuthUserIdentity | null> => {
    const userId = getAuthUserId(context);

    if (!userId) {
        return null;
    }

    // `findFirst` on `_id`, not `get`: a `get` of a `.global()` id probes every
    // global table, on every authenticated call (root AGENTS.md, "Database access").
    const user = await context.db.user.findFirst({ where: { _id: userId } });

    if (!user) {
        return null;
    }

    const identity = await context.auth.getIdentity();
    const sessionId = identity?.sessionId;

    return {
        email: user.email,
        name: user.name ?? undefined,
        pictureUrl: user.image ?? undefined,
        sessionId: sessionId as Id<"session">,
        subject: userId,
        userId,
    };
};

/**
 * Headers that authenticate a server-side `auth.api.*` call as the current user.
 *
 * better-auth's server API authenticates from headers, not from an argument, so
 * calling it on a user's behalf means handing it their bearer token. `session`
 * may be passed in when the caller already loaded it, to avoid a second read.
 */
export const getHeaders = async (context: ReadContext, session?: Doc<"session"> | null): Promise<Headers> => {
    const resolved = session ?? (await getSession(context));
    const headers = new Headers();

    if (resolved?.token) {
        headers.set("Authorization", `Bearer ${resolved.token}`);
    }

    return headers;
};

/** Client signals recorded on the session row, used for rate-limit keying and audit. */
export interface SessionClientSignals {
    ip?: string;
    userAgent?: string;
}

/**
 * The caller's IP and user agent, as better-auth recorded them at sign-in.
 *
 * Used to key rate limits for anonymous callers. Returns `{}` rather than
 * throwing when there is no session — an anonymous request still needs a limit,
 * and the caller falls back to a shared bucket.
 */
export const getSessionNetworkSignals = async (context: ReadContext, session?: Doc<"session"> | null): Promise<SessionClientSignals> => {
    const resolved = session ?? (await getSession(context));

    if (!resolved) {
        return {};
    }

    return { ip: resolved.ipAddress ?? undefined, userAgent: resolved.userAgent ?? undefined };
};
