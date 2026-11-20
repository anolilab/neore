/**
 * Watching the agent's cloud browser while it works (read-only).
 *
 * `getThreadBrowser` is the live, secret-free status a thread page subscribes to: whether a browser is running for
 * the thread, an opaque name for it, the page it is on, and when it will be reaped if the agent stops using it. `openLiveView` asks the
 * provider, with the platform token, for a short-lived read-only view URL of that browser. The URL is a credential:
 * it comes only from this action, only to a caller with full read access to the thread, and is never stored. A
 * locked thread shows neither (no passcode proof reaches either procedure), and neither does a trashed one.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { QueryCtx } from "../_generated/server";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { BROWSER_LIVE_VIEW_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } from "../env";
import { authAction, authQuery, internalQuery, rateLimit } from "../lib/crpc";
import { throwThreadNotFound } from "../lib/error-helpers";
import { fetchWithDeadline } from "../lib/fetch-timeout";
import { systemDb } from "../lib/rls/scope";
import { activeThreadSession } from "./functions";
import { browserAliveUntil, LIVE_VIEW_CONNECT_DEADLINE_MS, liveViewRequest, liveViewUrlFrom, watchableSessionId } from "./live-view-logic";

type ReaderBrowser =
    | { accessUntil?: number; browserId: string; currentUrl?: string; idleUntil: number; kind: "watchable"; providerSessionId: string }
    | { kind: "denied" }
    | { kind: "none" };

/**
 * Names one browser without revealing it: it changes when the renderer replaces the browser on the same row, so an
 * open view knows its URL is for a browser that is gone. A digest, so the provider's session id never reaches a client.
 */
const browserIdOf = async (sessionId: Id<"browserSessions">, providerSessionId: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sessionId}:${providerSessionId}`));

    return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The ONE decision both procedures make, at the moment of the call: the caller reads the thread right now (owner or
 * live grantee, not locked for them, not trashed), and its browser is still running.
 *
 * `primary`: the grant is a `.global()` row, and a read replica can still hold one an admin just removed. Minting a
 * view credential reads it from the primary, so a revoked reader gets no new URL. The status query stays on the
 * replica like every other read of the thread's content: it carries no credential, and the reader's messages read
 * at the same consistency. The thread row (lock, trash) is on the owner's shard, which has no replica.
 */
const readerBrowser = async (
    ctx: QueryCtx,
    threadId: Id<"threads">,
    userId: string,
    now: number,
    options: { primary?: boolean } = {},
): Promise<ReaderBrowser> => {
    const access = await resolveThreadReadAccess(ctx, threadId, userId, undefined, options);

    if (access?.kind !== "full") {
        return { kind: "denied" };
    }

    // A trashed chat shows its browser to no one, like every other read of a trashed thread.
    if (access.thread.deleted === true) {
        return { kind: "none" };
    }

    // The same row the agent's next action uses (`getActiveSession`), so the view is of the browser the agent drives.
    const session = await activeThreadSession(systemDb(ctx), threadId);
    const providerSessionId = watchableSessionId(session, now);

    if (session === null || providerSessionId === undefined) {
        return { kind: "none" };
    }

    return {
        ...(access.expiresAt !== undefined && { accessUntil: access.expiresAt }),
        browserId: await browserIdOf(session._id, providerSessionId),
        currentUrl: session.currentUrl,
        idleUntil: browserAliveUntil(session),
        kind: "watchable",
        providerSessionId,
    };
};

/**
 * The thread's running cloud browser, or `null`. A grantee's read goes through the thread decision, then past row-level
 * security. `accessUntil` is when a grantee's grant ends: a live query is re-run only by a write to what it read, not
 * by the clock, so the client stops showing the status then and asks again, and every answer after it is `null`.
 */
export const getThreadBrowser = authQuery
    .input({ threadId: v.id("threads") })
    .output(
        v.union(v.null(), v.object({ accessUntil: v.optional(v.number()), browserId: v.string(), currentUrl: v.optional(v.string()), idleUntil: v.number() })),
    )
    .query(async ({ args: { threadId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now);

        if (browser.kind !== "watchable") {
            return null;
        }

        return {
            ...(browser.accessUntil !== undefined && { accessUntil: browser.accessUntil }),
            browserId: browser.browserId,
            currentUrl: browser.currentUrl,
            idleUntil: browser.idleUntil,
        };
    });

/** {@link readerBrowser} for the action, which reaches the database only through `runQuery`; the grant from the primary. */
export const getReaderBrowser = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.object({ kind: v.literal("denied") }),
            v.object({ kind: v.literal("none") }),
            v.object({ kind: v.literal("watchable"), providerSessionId: v.string() }),
        ),
    )
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, userId, Date.now(), { primary: true });

        return browser.kind === "watchable" ? { kind: browser.kind, providerSessionId: browser.providerSessionId } : browser;
    });

/**
 * A read-only live view URL for the thread's running browser. `ended` when there is none or the provider no longer
 * has it; `unavailable` when the deploy has no token for it or the provider refused.
 */
export const openLiveView = authAction
    .input({ threadId: v.id("threads") })
    .use(rateLimit("browser/liveView"))
    .output(
        v.union(
            v.object({ connectBy: v.number(), status: v.literal("ok"), url: v.string() }),
            v.object({ status: v.literal("ended") }),
            v.object({ status: v.literal("unavailable") }),
        ),
    )
    .action(async ({ args: { threadId }, ctx }) => {
        const browser = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { threadId, userId: ctx.user.userId });

        if (browser.kind === "denied") {
            return throwThreadNotFound();
        }

        if (browser.kind === "none") {
            return { status: "ended" as const };
        }

        if (CLOUDFLARE_ACCOUNT_ID === "" || BROWSER_LIVE_VIEW_API_TOKEN === "") {
            return { status: "unavailable" as const };
        }

        const request = liveViewRequest(CLOUDFLARE_ACCOUNT_ID, BROWSER_LIVE_VIEW_API_TOKEN, browser.providerSessionId);
        const response = await fetchWithDeadline(request.url, request.init);

        if (!response.ok) {
            // A refused answer's body is never read: release its stream.
            await response.body?.cancel().catch(() => undefined);
            ctx.log.event("browser.live_view_opened", { ok: false, status: response.status });

            // Not found: the browser is gone, or the account cannot see it. A viewer never closes the agent's session
            // row; the agent's next action finds out on its own path.
            return response.status === 404 || response.status === 410 ? { status: "ended" as const } : { status: "unavailable" as const };
        }

        const url = liveViewUrlFrom(await response.json().catch(() => null));

        ctx.log.event("browser.live_view_opened", { ok: url !== undefined, status: response.status });

        if (url === undefined) {
            return { status: "unavailable" as const };
        }

        // The provider call takes time: a grant removed, or a chat locked or trashed, while it ran gets no URL either.
        const after = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { threadId, userId: ctx.user.userId });

        if (after.kind === "denied") {
            return throwThreadNotFound();
        }

        if (after.kind === "none") {
            return { status: "ended" as const };
        }

        return { connectBy: Date.now() + LIVE_VIEW_CONNECT_DEADLINE_MS, status: "ok" as const, url };
    });
