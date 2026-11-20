/**
 * Watching the agent's cloud browser while it works (read-only).
 *
 * `getThreadBrowser` is the live, secret-free status a thread page subscribes to: whether a browser is running for
 * the thread, the page it is on, and when it will be reaped if the agent stops using it. `openLiveView` asks the
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
import { browserAliveUntil, LIVE_VIEW_CONNECT_DEADLINE_MS, liveViewRequest, liveViewUrlFrom, watchableSessionId } from "./live-view-logic";

type ReaderBrowser = { currentUrl?: string; idleUntil: number; kind: "watchable"; providerSessionId: string } | { kind: "denied" } | { kind: "none" };

/**
 * The ONE decision both procedures make, at the moment of the call: the caller reads the thread right now (owner or
 * live grantee, not locked for them, not trashed), and its browser is still running.
 */
const readerBrowser = async (ctx: QueryCtx, threadId: Id<"threads">, userId: string, now: number): Promise<ReaderBrowser> => {
    const access = await resolveThreadReadAccess(ctx, threadId, userId);

    if (access?.kind !== "full") {
        return { kind: "denied" };
    }

    // A trashed chat shows its browser to no one, like every other read of a trashed thread.
    if (access.thread.deleted === true) {
        return { kind: "none" };
    }

    const session = await systemDb(ctx)
        .query("browserSessions")
        .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
        .first();
    const providerSessionId = watchableSessionId(session, now);

    if (session === null || providerSessionId === undefined) {
        return { kind: "none" };
    }

    return { currentUrl: session.currentUrl, idleUntil: browserAliveUntil(session), kind: "watchable", providerSessionId };
};

/** The thread's running cloud browser, or `null`. A grantee's read goes through the thread decision, then past row-level security. */
export const getThreadBrowser = authQuery
    .input({ threadId: v.id("threads") })
    .output(v.union(v.null(), v.object({ currentUrl: v.optional(v.string()), idleUntil: v.number() })))
    .query(async ({ args: { threadId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now);

        return browser.kind === "watchable" ? { currentUrl: browser.currentUrl, idleUntil: browser.idleUntil } : null;
    });

/** {@link readerBrowser} for the action, which reaches the database only through `runQuery`. */
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
        const browser = await readerBrowser(ctx, threadId, userId, Date.now());

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

        return { connectBy: Date.now() + LIVE_VIEW_CONNECT_DEADLINE_MS, status: "ok" as const, url };
    });
