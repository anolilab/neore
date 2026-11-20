/**
 * Watching the agent's cloud browser while it works (read-only).
 *
 * `getThreadBrowser` is the live, secret-free status a thread page subscribes to: whether a browser is running for
 * the thread, an opaque name for it, the page it is on, and when it will be reaped if the agent stops using it. `openLiveView` asks the
 * provider, with the platform token, for a short-lived read-only view URL of that browser. The URL is a credential:
 * it comes only from this action, only to a caller with full read access to the thread, and is never stored. A
 * locked thread shows neither (no passcode proof reaches either procedure), and neither does a trashed one.
 */
import { browserAction, type BrowserActionResponse, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { QueryCtx } from "../_generated/server";
import { meetsThreadPermission, resolveThreadReadAccess } from "../agent/thread-read-access";
import { BROWSER_LIVE_VIEW_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } from "../env";
import { authAction, authMutation, authQuery, internalMutation, internalQuery, rateLimit } from "../lib/crpc";
import { throwForbidden, throwThreadNotFound } from "../lib/error-helpers";
import { fetchWithDeadline } from "../lib/fetch-timeout";
import { systemDb } from "../lib/rls/scope";
import { isServiceBound, serviceFetch } from "../lib/services";
import { validateDomain } from "../chat/tools/utilities";
import { activeThreadSession } from "./functions";
import { patchRow } from "../lib/patch";
import {
    browserAliveUntil,
    CONTROL_IDLE_MS,
    controlNavigationBudget,
    controlNavigationHold,
    controlStateOf,
    LIVE_VIEW_CONNECT_DEADLINE_MS,
    liveViewRequest,
    liveViewUrlFrom,
    NO_PROVIDER_SESSION,
    watchableSessionId,
} from "./live-view-logic";

type ReaderBrowser =
    | {
          accessUntil?: number;
          browserId: string;
          /** The caller may drive the browser: the owner, or a grantee with write access. */
          canControl: boolean;
          control?: { by: string; until: number };
          currentUrl?: string;
          idleUntil: number;
          kind: "watchable";
          providerSessionId: string;
          session: Doc<"browserSessions">;
      }
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
        canControl: meetsThreadPermission(access.permission, "write"),
        ...(controlStateOf(session, now) === "person" &&
            session.control !== undefined && { control: { by: session.control.by, until: session.control.until } }),
        currentUrl: session.currentUrl,
        idleUntil: browserAliveUntil(session),
        kind: "watchable",
        providerSessionId,
        session,
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
        v.union(
            v.null(),
            v.object({
                accessUntil: v.optional(v.number()),
                browserId: v.string(),
                canControl: v.boolean(),
                /** A person drives the browser until `until`; `byYou`: the caller. */
                control: v.optional(v.object({ byYou: v.boolean(), until: v.number() })),
                currentUrl: v.optional(v.string()),
                idleUntil: v.number(),
            }),
        ),
    )
    .query(async ({ args: { threadId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now);

        if (browser.kind !== "watchable") {
            return null;
        }

        return {
            ...(browser.accessUntil !== undefined && { accessUntil: browser.accessUntil }),
            browserId: browser.browserId,
            canControl: browser.canControl,
            ...(browser.control !== undefined && { control: { byYou: browser.control.by === ctx.user.userId, until: browser.control.until } }),
            currentUrl: browser.currentUrl,
            idleUntil: browser.idleUntil,
        };
    });

/**
 * {@link readerBrowser} for the action, which reaches the database only through `runQuery`; the grant from the primary.
 * `at`: the action's clock after a provider call. The lease is judged at the later of it and `ctx.now`, so one that
 * lapsed while the provider minted is over even where a nested call still reads the time its action started at.
 */
export const getReaderBrowser = internalQuery
    .input({ at: v.optional(v.number()), threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.object({ kind: v.literal("denied") }),
            v.object({ kind: v.literal("none") }),
            v.object({
                canControl: v.boolean(),
                /** Someone other than the caller drives the browser. */
                controlledByOther: v.boolean(),
                /** The caller holds a lease they have not handed back. */
                inControl: v.boolean(),
                kind: v.literal("watchable"),
                providerSessionId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { at, threadId, userId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, userId, Math.max(ctx.now, at ?? 0), { primary: true });

        if (browser.kind !== "watchable") {
            return browser;
        }

        return {
            canControl: browser.canControl,
            controlledByOther: browser.control !== undefined && browser.control.by !== userId,
            inControl: browser.control?.by === userId && browser.session.control?.ended === undefined,
            kind: browser.kind,
            providerSessionId: browser.providerSessionId,
        };
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
            v.object({ status: v.literal("controlled") }),
            v.object({ status: v.literal("ended") }),
            v.object({ status: v.literal("unavailable") }),
        ),
    )
    .action(async ({ args: { threadId }, ctx }) => {
        const browser = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { threadId, userId: ctx.user.userId });

        if (browser.kind === "denied") {
            return throwThreadNotFound();
        }

        // Someone else drives the browser and may be typing a password: nobody else watches meanwhile.
        if (browser.kind === "watchable" && browser.controlledByOther) {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "controlled" });

            return { status: "controlled" as const };
        }

        if (browser.kind === "none") {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "ended" });

            return { status: "ended" as const };
        }

        // The card still offers the view on such a deploy, and says it is not available when asked: this event tells why.
        if (CLOUDFLARE_ACCOUNT_ID === "" || BROWSER_LIVE_VIEW_API_TOKEN === "") {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "not_configured" });

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

        if (url === undefined) {
            ctx.log.event("browser.live_view_opened", { ok: false, status: response.status });

            return { status: "unavailable" as const };
        }

        // The provider call takes time: a grant removed, or a chat locked or trashed, while it ran gets no URL either.
        const after = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { at: Date.now(), threadId, userId: ctx.user.userId });

        if (after.kind === "denied") {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "denied_after_mint" });

            return throwThreadNotFound();
        }

        if (after.kind === "none") {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "ended_after_mint" });

            return { status: "ended" as const };
        }

        if (after.controlledByOther) {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "controlled_after_mint" });

            return { status: "controlled" as const };
        }

        // An agent action replaced the browser while the provider minted: the URL shows one the agent no longer drives.
        if (after.providerSessionId !== browser.providerSessionId) {
            ctx.log.event("browser.live_view_opened", { ok: false, reason: "replaced_after_mint" });

            return { status: "ended" as const };
        }

        ctx.log.event("browser.live_view_opened", { ok: true, status: response.status });

        return { connectBy: Date.now() + LIVE_VIEW_CONNECT_DEADLINE_MS, status: "ok" as const, url };
    });

/**
 * A person's control is activity on the browser: their view is connected to it, so the provider's idle clock starts
 * only when they stop. Stamped on each claim, renewal and hand back, so the browser does not read as reaped the moment
 * a long session of control ends.
 */
const activeNow = (session: Doc<"browserSessions">, now: number): { lastActivityAt: number } => {
    return { lastActivityAt: Math.max(session.lastActivityAt, now) };
};

// ── Taking control ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's claim on the browser, in one transaction with the agent's `beginSessionUse`: only someone who may act in
 * the thread, only one person at a time, and never while an agent action is still running on it (its input would land
 * among theirs). A claim by the person who holds it already renews it, also a lease they handed back while their page
 * still loads: the renewal is a lease again, not the end of one. Every claim writes a new `claim`, so a failed one
 * drops only a lease no later claim renewed.
 */
export const claimControl = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.object({ kind: v.union(v.literal("busy"), v.literal("denied"), v.literal("none"), v.literal("read_only"), v.literal("taken")) }),
            v.object({
                claim: v.string(),
                /** `fresh`: this claim started the lease (a renewal by its holder did not), so only it may drop it again. */
                fresh: v.boolean(),
                /** This renewal took back a lease its holder handed back while their page loads: a dropped claim hands it back again. */
                handedBack: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("left"))),
                kind: v.literal("ok"),
                providerSessionId: v.string(),
                /** An earlier lease ended and the agent was not told yet: a dropped claim puts that note back. */
                returned: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("idle"), v.literal("left"))),
            }),
        ),
    )
    .mutation(async ({ args: { threadId, userId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, userId, ctx.now, { primary: true });

        if (browser.kind !== "watchable") {
            return { kind: browser.kind };
        }

        if (!browser.canControl) {
            return { kind: "read_only" as const };
        }

        if (browser.control !== undefined && browser.control.by !== userId) {
            return { kind: "taken" as const };
        }

        if ((browser.session.inUseHolds ?? []).some((until) => until > ctx.now)) {
            return { kind: "busy" as const };
        }

        const claim = crypto.randomUUID();
        const current = browser.session.control;
        const until = ctx.now + CONTROL_IDLE_MS;

        // The holder's lease goes on: its start and a page still loading stay, a hand back does not.
        if (browser.control !== undefined && current !== undefined) {
            await patchRow(ctx.db, "browserSessions", browser.session, {
                ...activeNow(browser.session, ctx.now),
                control: {
                    by: userId,
                    claim,
                    ...(current.navigatingUntil !== undefined && { navigatingUntil: current.navigatingUntil }),
                    since: current.since,
                    until,
                },
            });

            return {
                claim,
                fresh: false,
                kind: "ok" as const,
                providerSessionId: browser.providerSessionId,
                ...(current.ended !== undefined && { handedBack: current.ended }),
            };
        }

        const returned = current !== undefined && controlStateOf(browser.session, ctx.now) === "returned" ? (current.ended ?? ("idle" as const)) : undefined;

        await patchRow(ctx.db, "browserSessions", browser.session, {
            ...activeNow(browser.session, ctx.now),
            control: { by: userId, claim, since: ctx.now, until },
        });

        return { claim, fresh: true, kind: "ok" as const, providerSessionId: browser.providerSessionId, ...(returned !== undefined && { returned }) };
    });

/**
 * The claim of `takeControl` came to nothing (no view, or the caller lost the right while it was minted): the
 * lease goes, only while it is still that claim's and not handed back. A note for the agent the claim overwrote comes
 * back as an ended lease, so its next action still hears that a person drove the browser.
 */
export const dropControlClaim = internalMutation
    .input({
        claim: v.string(),
        handedBack: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("left"))),
        returned: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("idle"), v.literal("left"))),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { claim, handedBack, returned, threadId, userId }, ctx }) => {
        const session = await activeThreadSession(ctx.db, threadId);
        const control = session?.control;

        if (session === null || control?.by !== userId || control.claim !== claim || control.ended !== undefined) {
            return;
        }

        // A renewal of a lease handed back mid-load: the hand back stands again, until the page has loaded.
        if (handedBack !== undefined) {
            await patchRow(ctx.db, "browserSessions", session, {
                control: { ...control, ended: handedBack, until: Math.max(ctx.now, control.navigatingUntil ?? 0) },
            });

            return;
        }

        await patchRow(ctx.db, "browserSessions", session, {
            control:
                returned === undefined
                    ? undefined
                    : { by: control.by, claim, ...(returned !== "idle" && { ended: returned }), since: control.since, until: ctx.now },
        });
    });

/**
 * Take control of the thread's browser: the agent's browser actions are refused until the person hands it back, leaves
 * the view, or gives no input for {@link CONTROL_IDLE_MS}. Answers an interactive live view URL, a credential like the
 * read-only one: only to the person in control, never stored.
 *
 * The provider has no way to revoke a live view once connected: ending the lease stops our server from honouring the
 * holder (`keepControl`, `navigateInControl`) and lets the agent act again, but an interactive view still open keeps
 * reaching the page until the person's card closes it or the browser goes. The URL is therefore re-checked against
 * the claim after the provider minted it, and is never returned to a caller who no longer holds the lease.
 */
export const takeControl = authAction
    .input({ threadId: v.id("threads") })
    .use(rateLimit("browser/liveView"))
    .output(
        v.union(
            v.object({ connectBy: v.number(), status: v.literal("ok"), url: v.string() }),
            v.object({ status: v.union(v.literal("busy"), v.literal("ended"), v.literal("taken"), v.literal("unavailable")) }),
        ),
    )
    .action(async ({ args: { threadId }, ctx }) => {
        const { userId } = ctx.user;
        const claim = await ctx.runMutation(internal.browser.live_view.claimControl, { threadId, userId });

        if (claim.kind === "denied") {
            return throwThreadNotFound();
        }

        if (claim.kind === "read_only") {
            return throwForbidden("Only someone who may write in this chat can take control of its browser.");
        }

        if (claim.kind !== "ok") {
            ctx.log.event("browser.control_taken", { ok: false, reason: claim.kind });

            return { status: claim.kind === "none" ? ("ended" as const) : claim.kind };
        }

        // A renewal's failed mint leaves the lease alone (the person is still at work in the view they have), unless it
        // took back a lease they had handed back: that is handed back again.
        const drop = async (): Promise<void> => {
            if (claim.fresh || claim.handedBack !== undefined) {
                await ctx.runMutation(internal.browser.live_view.dropControlClaim, {
                    claim: claim.claim,
                    threadId,
                    userId,
                    ...(claim.handedBack !== undefined && { handedBack: claim.handedBack }),
                    ...(claim.returned !== undefined && { returned: claim.returned }),
                });
            }
        };
        const refuse = async (status: "ended" | "taken" | "unavailable", reason: string): Promise<{ status: "ended" | "taken" | "unavailable" }> => {
            await drop();
            ctx.log.event("browser.control_taken", { ok: false, reason });

            return { status };
        };

        if (CLOUDFLARE_ACCOUNT_ID === "" || BROWSER_LIVE_VIEW_API_TOKEN === "") {
            return await refuse("unavailable", "not_configured");
        }

        const request = liveViewRequest(CLOUDFLARE_ACCOUNT_ID, BROWSER_LIVE_VIEW_API_TOKEN, claim.providerSessionId, true);
        const response = await fetchWithDeadline(request.url, request.init).catch(() => undefined);

        if (!response?.ok) {
            await response?.body?.cancel().catch(() => undefined);

            return await refuse(response?.status === 404 || response?.status === 410 ? "ended" : "unavailable", `provider_${response?.status ?? "error"}`);
        }

        const url = liveViewUrlFrom(await response.json().catch(() => null));

        if (url === undefined) {
            return await refuse("unavailable", "bad_url");
        }

        // The provider call takes time: a grant removed or lowered, a chat locked or trashed, a lease handed back, taken
        // over or lapsed, or a browser replaced while it ran gets no URL.
        const after = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { at: Date.now(), threadId, userId });

        if (after.kind === "denied") {
            await refuse("ended", "denied_after_mint");

            return throwThreadNotFound();
        }

        if (after.kind === "none" || after.providerSessionId !== claim.providerSessionId) {
            return await refuse("ended", "ended_after_mint");
        }

        if (!after.canControl) {
            await refuse("ended", "read_only_after_mint");

            return throwForbidden("Only someone who may write in this chat can take control of its browser.");
        }

        if (!after.inControl) {
            return await refuse(after.controlledByOther ? "taken" : "unavailable", "lease_ended_after_mint");
        }

        ctx.log.event("browser.control_taken", { ok: true, reason: claim.fresh ? "fresh" : "renewed" });

        return { connectBy: Date.now() + LIVE_VIEW_CONNECT_DEADLINE_MS, status: "ok" as const, url };
    });

/** The person in control gave input: the idle timeout starts again. `null`: they no longer hold control (or may not). */
export const keepControl = authMutation
    .input({ threadId: v.id("threads") })
    .use(rateLimit("browser/control"))
    .output(v.union(v.null(), v.object({ until: v.number() })))
    .mutation(async ({ args: { threadId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now, { primary: true });

        // A lease handed back while the person's page still loads is over: it is not renewed.
        if (browser.kind !== "watchable" || !browser.canControl || browser.control?.by !== ctx.user.userId || browser.session.control?.ended !== undefined) {
            return null;
        }

        const until = ctx.now + CONTROL_IDLE_MS;

        await patchRow(systemDb(ctx), "browserSessions", browser.session, {
            ...activeNow(browser.session, ctx.now),
            control: { ...browser.session.control, by: browser.control.by, until },
        });

        return { until };
    });

/**
 * The person gives the browser back (`handed_back`) or left the view (`left`); the agent's next action is told. Takes
 * no thread decision and no rate limit: it only ends the caller's own lease.
 */
export const handBack = authMutation
    .input({ reason: v.union(v.literal("handed_back"), v.literal("left")), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { reason, threadId }, ctx }) => {
        const session = await activeThreadSession(systemDb(ctx), threadId);

        if (session?.control?.by === ctx.user.userId && controlStateOf(session, ctx.now) === "person") {
            // A page the person asked for is still loading: the agent waits for it too, then the lease ends with it.
            const until = Math.max(ctx.now, session.control.navigatingUntil ?? 0);

            await patchRow(systemDb(ctx), "browserSessions", session, {
                ...activeNow(session, ctx.now),
                control: { ...session.control, ended: reason, until },
            });
            ctx.log.event("browser.control_returned", { reason });
        }

        return null;
    });

/**
 * The person in control opens a page: through the renderer, so the same checks as the agent's `navigate` apply (the
 * thread owner's browser setting and domain lists for the address typed, and the renderer's guard against private
 * and metadata addresses for every request, redirects included). The lists are not a boundary for the person: the
 * interactive view lets them follow any link, so a redirect is no different from a click.
 */
export const navigateInControl = authAction
    .input({ threadId: v.id("threads"), url: v.string().max(2048) })
    .use(rateLimit("browser/control"))
    .output(v.union(v.object({ status: v.literal("ok"), url: v.optional(v.string()) }), v.object({ error: v.string(), status: v.literal("refused") })))
    .action(async ({ args: { threadId, url }, ctx }) => {
        const { userId } = ctx.user;

        if (!isServiceBound(ctx, "browserRenderer")) {
            return { error: "Browser automation is not configured.", status: "refused" as const };
        }

        const navigation = await ctx.runMutation(internal.browser.live_view.beginControlNavigation, { threadId, url, userId });

        if (navigation.kind === "denied") {
            return throwThreadNotFound();
        }

        if (navigation.kind === "loading") {
            return { error: "The page you opened is still loading.", status: "refused" as const };
        }

        if (navigation.kind === "blocked") {
            return { error: navigation.error, status: "refused" as const };
        }

        if (navigation.kind !== "ok") {
            return { error: "You do not have control of the browser.", status: "refused" as const };
        }

        const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
        const startedAt = Date.now();
        // The hold was written before this call: one that starts late is cut off before the hold ends, never after it,
        // and one too late for any of it is not sent (no answer, like a call that failed: the browser is left as it is).
        const budget = controlNavigationBudget(navigation.navigatingUntil, startedAt);
        const { data } =
            budget === 0
                ? { data: undefined }
                : await browserAction({
                      body: { action: "navigate", sessionId: navigation.providerSessionId, url },
                      client,
                      signal: AbortSignal.timeout(budget),
                  }).catch(() => {
                      return { data: undefined };
                  });
        const result = data as BrowserActionResponse | undefined;

        // The audit row, on the row the navigation began on, and a browser the renderer replaced or closed (a blocked
        // redirect closes it and answers no id: nothing is left to watch). Not the session's page: others who watch the
        // chat read that, and what the person opens is theirs; only the owner's history shows it, and whether they or a collaborator opened it. Before the lease's hold ends, so the agent
        // never acts on a row that still names a browser that is gone. A failed write never keeps the hold: the agent's
        // next action finds a browser that is gone on its own path, as it does one the provider reaped.
        try {
            await ctx.runMutation(internal.browser.functions.logAction, {
                action: "navigate",
                actor: navigation.byOwner ? "owner" : "collaborator",
                durationMs: Date.now() - startedAt,
                ...(result?.success !== true && { errorMessage: result?.error ?? "The page could not be opened." }),
                ...(result !== undefined && { providerSessionId: result.sessionId ?? NO_PROVIDER_SESSION }),
                sessionId: navigation.sessionId,
                startedAt,
                startedWithProviderSessionId: navigation.providerSessionId,
                success: result?.success === true,
                target: url,
            });
        } finally {
            await ctx.runMutation(internal.browser.live_view.endControlNavigation, {
                navigatingUntil: navigation.navigatingUntil,
                sessionId: navigation.sessionId,
                userId,
            });
        }

        if (result?.success !== true) {
            return { error: result?.error ?? "The page could not be opened.", status: "refused" as const };
        }

        return { status: "ok" as const, ...(result.url !== undefined && { url: result.url }) };
    });

/**
 * The person in control starts opening a page: only while they hold the lease (not handed back), may write in the
 * thread, the owner has not turned browsing off or listed the address, and no page they asked for still loads. The
 * lease lasts at least as long as the renderer call (`controlNavigationHold`: the call may start a little later and is
 * cut off before the hold ends), and a hand back meanwhile waits for it ({@link handBack}), so the agent never acts
 * while the page the person asked for loads. `navigatingUntil` names this navigation.
 */
export const beginControlNavigation = internalMutation
    .input({ threadId: v.id("threads"), url: v.string(), userId: v.string() })
    .output(
        v.union(
            v.object({ kind: v.union(v.literal("denied"), v.literal("loading"), v.literal("refused")) }),
            v.object({ error: v.string(), kind: v.literal("blocked") }),
            v.object({
                /** The caller owns the chat (else a collaborator with write access), for the audit row. */
                byOwner: v.boolean(),
                kind: v.literal("ok"),
                navigatingUntil: v.number(),
                providerSessionId: v.string(),
                sessionId: v.id("browserSessions"),
            }),
        ),
    )
    .mutation(async ({ args: { threadId, url, userId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, userId, ctx.now, { primary: true });

        if (browser.kind === "denied") {
            return { kind: "denied" as const };
        }

        const control = browser.kind === "watchable" ? browser.session.control : undefined;

        if (browser.kind !== "watchable" || !browser.canControl || browser.control?.by !== userId || control === undefined || control.ended !== undefined) {
            return { kind: "refused" as const };
        }

        // One page at a time: a second would end its hold when the first one loads, while it still runs.
        if ((control.navigatingUntil ?? 0) > ctx.now) {
            return { kind: "loading" as const };
        }

        const preferences = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", browser.session.userId))
            .first();
        const blocked = validateDomain(url, preferences?.browserSettings ?? {});

        if (blocked !== null) {
            return { error: blocked, kind: "blocked" as const };
        }

        const navigatingUntil = controlNavigationHold(ctx.now);

        await patchRow(ctx.db, "browserSessions", browser.session, {
            control: { ...control, navigatingUntil, until: Math.max(control.until, navigatingUntil) },
        });

        return {
            byOwner: browser.session.userId === userId,
            kind: "ok" as const,
            navigatingUntil,
            providerSessionId: browser.providerSessionId,
            sessionId: browser.session._id,
        };
    });

/** The person's page loaded (or failed): a lease handed back meanwhile ends now. Only that navigation's own hold ends. */
export const endControlNavigation = internalMutation
    .input({ navigatingUntil: v.number(), sessionId: v.id("browserSessions"), userId: v.string() })
    .mutation(async ({ args: { navigatingUntil, sessionId, userId }, ctx }) => {
        const session = await ctx.db.get("browserSessions", sessionId);
        const control = session?.control;

        if (!session || control?.by !== userId || control.navigatingUntil !== navigatingUntil) {
            return;
        }

        // `undefined` removes the deadline: the page loaded.
        await patchRow(ctx.db, "browserSessions", session, {
            control: { ...control, navigatingUntil: undefined, until: control.ended === undefined ? control.until : Math.min(control.until, ctx.now) },
        });
    });
