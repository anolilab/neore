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
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { QueryCtx } from "../_generated/server";
import { meetsThreadPermission, resolveThreadReadAccess } from "../agent/thread-read-access";
import { BROWSER_LIVE_VIEW_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } from "../env";
import { authAction, authMutation, authQuery, internalMutation, internalQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { throwForbidden, throwThreadNotFound } from "../lib/error-helpers";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { fetchWithDeadline } from "../lib/fetch-timeout";
import { getRateLimitKey, getUserTier } from "../lib/rate-limiter";
import { systemDb } from "../lib/rls/scope";
import { isServiceBound, serviceFetch } from "../lib/services";
import { validateDomain } from "../chat/tools/utilities";
import { activeThreadSession } from "./functions";
import { claimIdOf, releaseTokenFor } from "./release-token";
import { patchRow } from "../lib/patch";
import { currentShard, ROOT_SHARD_KEY } from "../lib/shard-context";
import {
    browserAliveUntil,
    browserIdOf,
    CONTROL_IDLE_MS,
    rendererCallBudget,
    rendererCallHold,
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
          /** A person drives the browser until `until`; `byCaller`: the caller holds the lease. */
          control?: { byCaller: boolean; until: number };
          currentUrl?: string;
          idleUntil: number;
          kind: "watchable";
          providerSessionId: string;
          session: Doc<"browserSessions">;
          /**
           * The shard the session row is on: the one serving this read (the thread owner's). Never the row's `userId`, which names whoever opened
           * the browser (a collaborator's first action in a shared thread opens it on the owner's shard).
           */
          shardKey: string;
      }
    | { kind: "denied" }
    | { kind: "none" };

/**
 * Who holds a lease, as `browserSessions.control.by` stores it: a keyed hash of the session and the person, never their
 * id. The row is on the thread owner's shard, which a collaborator's account deletion never reaches, so it must not
 * name them; the key is the backend's own signing secret (the one the unlock proofs use), so no one without it can
 * tell whose lease it was. `undefined` on a deploy without that secret: no lease is taken there.
 */
export const controlHolder = async (sessionId: Id<"browserSessions">, userId: string): Promise<string | undefined> => {
    const secret = process.env.STORAGE_SIGNING_SECRET ?? "";

    return secret === "" ? undefined : await hmacSha256Hex(secret, `browser-control\n${sessionId}\n${userId}`);
};

/**
 * `claim` names the lease's view: its own claim, or the one a renewal still being minted replaces (`renewing`), so the
 * view that holds it keeps working until the renewal settles.
 */
const claimNames = <C extends { claim: string; renewing?: string }>(control: C | undefined, claim: string): control is C =>
    control !== undefined && (control.claim === claim || control.renewing === claim);

/** The lease without a renewal in flight. */
const settled = <C extends { renewing?: string; renewingEnded?: string }>({
    renewing: _renewing,
    renewingEnded: _renewingEnded,
    ...control
}: C): Omit<C, "renewing" | "renewingEnded"> => control;

/**
 * Takes, keeps and drives no browser while an admin acts as the owner: the browser is signed in to the owner's sites,
 * and what is opened in it is recorded as the owner's own. `handBack` stays open, so a lease can always be ended.
 */
export const refuseImpersonation = (impersonatedBy: string | null | undefined): void => {
    if (impersonatedBy) {
        throw new LunoraError("FORBIDDEN", "The browser cannot be controlled while impersonating");
    }
};

/** The caller holds the lease on `session` (handed back or not, lapsed or not): its `by` is theirs. */
const holdsLease = async (session: Pick<Doc<"browserSessions">, "_id" | "control">, userId: string): Promise<boolean> => {
    if (session.control === undefined) {
        return false;
    }

    const holder = await controlHolder(session._id, userId);

    return holder !== undefined && timingSafeEqual(holder, session.control.by);
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
            session.control !== undefined && { control: { byCaller: await holdsLease(session, userId), until: session.control.until } }),
        currentUrl: session.currentUrl,
        idleUntil: browserAliveUntil(session),
        kind: "watchable",
        providerSessionId,
        session,
        shardKey: currentShard() ?? access.thread.userId ?? ROOT_SHARD_KEY,
    };
};

/** The public names of the claims that name `lease`: its own, and the one a renewal still being minted replaces. */
const leaseClaimIds = async (lease: { claim: string; renewing?: string }): Promise<string[]> =>
    await Promise.all([lease.claim, ...(lease.renewing === undefined ? [] : [lease.renewing])].map(async (claim: string) => await claimIdOf(claim)));

/**
 * The thread's running cloud browser, or `null`. A grantee's read goes through the thread decision, then past row-level
 * security. `accessUntil` is when a grantee's grant ends: a live query is re-run only by a write to what it read, not
 * by the clock, so the client stops showing the status then and asks again, and every answer after it is `null`.
 */
export const getThreadBrowser = authQuery
    /** `claim`: a view's own claim. The answer then says whether the lease is that view's, not only the caller's. */
    .input({ claim: v.optional(v.string().max(MAX_LENGTH.short)), threadId: v.id("threads") })
    .output(
        v.union(
            v.null(),
            v.object({
                accessUntil: v.optional(v.number()),
                browserId: v.string(),
                canControl: v.boolean(),
                /**
                 * A person drives the browser until `until`; `byYou`: the caller (from any of their tabs). `byClaim`, only
                 * with a `claim` asked for: the lease is the one that claim names, and not handed back. `claimIds`, only
                 * when it is the caller's: the public names (`claimIdOf`) of the claims that name the lease (its own, and
                 * the one a renewal still being minted replaces), so a tab tells at once that another of the caller's
                 * tabs took it over.
                 */
                control: v.optional(
                    v.object({ byClaim: v.optional(v.boolean()), byYou: v.boolean(), claimIds: v.optional(v.array(v.string())), until: v.number() }),
                ),
                currentUrl: v.optional(v.string()),
                idleUntil: v.number(),
                /**
                 * The server's clock at this answer. A lease that runs out writes nothing, so no new answer comes when it
                 * ends: the client compares `control.until` with this clock, not its own, and needs no second read.
                 */
                now: v.number(),
            }),
        ),
    )
    .query(async ({ args: { claim, threadId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now);

        if (browser.kind !== "watchable") {
            return null;
        }

        const { control } = browser;
        const lease = browser.session.control;

        return {
            ...(browser.accessUntil !== undefined && { accessUntil: browser.accessUntil }),
            browserId: browser.browserId,
            canControl: browser.canControl,
            ...(control !== undefined && {
                control: {
                    ...(claim !== undefined && { byClaim: control.byCaller && lease?.ended === undefined && claimNames(lease, claim) }),
                    byYou: control.byCaller,
                    ...(control.byCaller && lease !== undefined && { claimIds: await leaseClaimIds(lease) }),
                    until: control.until,
                },
            }),
            currentUrl: browser.currentUrl,
            idleUntil: browser.idleUntil,
            now: ctx.now,
        };
    });

/**
 * {@link readerBrowser} for the action, which reaches the database only through `runQuery`; the grant from the primary.
 * `at`: the action's clock after a provider call. The lease is judged at the later of it and `ctx.now`, so one that
 * lapsed while the provider minted is over even where a nested call still reads the time its action started at.
 */
export const getReaderBrowser = internalQuery
    .input({ at: v.optional(v.number()), claim: v.optional(v.string()), threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.object({ kind: v.literal("denied") }),
            v.object({ kind: v.literal("none") }),
            v.object({
                canControl: v.boolean(),
                /** Someone other than the caller drives the browser. */
                controlledByOther: v.boolean(),
                /** The caller holds a lease they have not handed back; with `claim`, the lease that claim names. */
                inControl: v.boolean(),
                kind: v.literal("watchable"),
                providerSessionId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { at, claim, threadId, userId }, ctx }) => {
        const browser = await readerBrowser(ctx, threadId, userId, Math.max(ctx.now, at ?? 0), { primary: true });

        if (browser.kind !== "watchable") {
            return browser;
        }

        return {
            canControl: browser.canControl,
            controlledByOther: browser.control !== undefined && !browser.control.byCaller,
            inControl:
                browser.control?.byCaller === true &&
                browser.session.control?.ended === undefined &&
                (claim === undefined || browser.session.control?.claim === claim),
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
 * drops only a lease no later claim renewed. A renewal keeps the claim it replaces as `renewing` while it is minted, so
 * the view that holds it is never told to close meanwhile; one that fails puts that claim back (or ends the lease, if
 * that view closed meanwhile), and one that succeeds drops it ({@link settleControlClaim}).
 */
export const claimControl = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.object({
                kind: v.union(v.literal("busy"), v.literal("denied"), v.literal("none"), v.literal("read_only"), v.literal("taken"), v.literal("unavailable")),
            }),
            v.object({
                claim: v.string(),
                /** `fresh`: this claim started the lease (a renewal by its holder did not), so only it may drop it again. */
                fresh: v.boolean(),
                /** This renewal took back a lease its holder handed back while their page loads: a dropped claim hands it back again. */
                handedBack: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("left"))),
                kind: v.literal("ok"),
                /** A renewal: the claim it replaced, which a failed renewal puts back for the view that still holds it. */
                previousClaim: v.optional(v.string()),
                providerSessionId: v.string(),
                /** An earlier lease ended and the agent was not told yet: a dropped claim puts that note back. */
                returned: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("idle"), v.literal("left"))),
                /** The thread owner's shard, where the session row is: a closing page's hand back is sent there. */
                shardKey: v.string(),
                /** When the lease this claim wrote ends unrenewed. */
                until: v.number(),
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

        if (browser.control !== undefined && !browser.control.byCaller) {
            return { kind: "taken" as const };
        }

        // An agent action still runs, on the browser the row names or on one it reads as reaped (the renderer may reconnect to it).
        if ([...(browser.session.inUseHolds ?? []), ...(browser.session.reapedHolds ?? [])].some((until) => until > ctx.now)) {
            return { kind: "busy" as const };
        }

        const by = await controlHolder(browser.session._id, userId);

        if (by === undefined) {
            return { kind: "unavailable" as const };
        }

        const claim = crypto.randomUUID();
        const current = browser.session.control;
        const until = ctx.now + CONTROL_IDLE_MS;

        // The holder's lease goes on: its start and a page still loading stay, a hand back does not.
        if (browser.control !== undefined && current !== undefined) {
            await patchRow(ctx.db, "browserSessions", browser.session, {
                ...activeNow(browser.session, ctx.now),
                control: {
                    by,
                    claim,
                    ...(current.navigatingUntil !== undefined && { navigatingUntil: current.navigatingUntil }),
                    // The view that holds the lease goes on under its claim while this one is minted (a renewal
                    // during another keeps the claim of the view that holds it, not that of the mint still running).
                    // That view closed during the mint still running: no view holds the lease, and how it closed stands.
                    ...(current.renewingEnded === undefined ? { renewing: current.renewing ?? current.claim } : { renewingEnded: current.renewingEnded }),
                    since: current.since,
                    until,
                },
            });

            return {
                claim,
                fresh: false,
                kind: "ok" as const,
                previousClaim: current.renewing ?? current.claim,
                providerSessionId: browser.providerSessionId,
                shardKey: browser.shardKey,
                until,
                ...(current.ended !== undefined && { handedBack: current.ended }),
            };
        }

        const returned = current !== undefined && controlStateOf(browser.session, ctx.now) === "returned" ? (current.ended ?? ("idle" as const)) : undefined;

        await patchRow(ctx.db, "browserSessions", browser.session, {
            ...activeNow(browser.session, ctx.now),
            control: { by, claim, since: ctx.now, until },
        });

        return {
            claim,
            fresh: true,
            kind: "ok" as const,
            providerSessionId: browser.providerSessionId,
            shardKey: browser.shardKey,
            until,
            ...(returned !== undefined && { returned }),
        };
    });

/**
 * The claim of `takeControl` came to nothing (no view, or the caller lost the right while it was minted), only while
 * the lease is still that claim's and not handed back. A fresh lease goes; a note for the agent the claim overwrote
 * comes back as an ended lease, so its next action still hears that a person drove the browser. A renewal puts back
 * the claim it replaced (`previousClaim`): the view that holds it keeps renewing, handing back and navigating.
 */
export const dropControlClaim = internalMutation
    .input({
        claim: v.string(),
        handedBack: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("left"))),
        previousClaim: v.optional(v.string()),
        returned: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("idle"), v.literal("left"))),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { claim, handedBack, previousClaim, returned, threadId, userId }, ctx }) => {
        const session = await activeThreadSession(ctx.db, threadId);
        const control = session?.control;

        if (session === null || control?.claim !== claim || control.ended !== undefined || !(await holdsLease(session, userId))) {
            return;
        }

        // A renewal of a lease handed back mid-load: the hand back stands again, until the page has loaded.
        if (handedBack !== undefined) {
            await patchRow(ctx.db, "browserSessions", session, {
                control: {
                    ...settled(control),
                    claim: previousClaim ?? claim,
                    ended: handedBack,
                    until: Math.max(ctx.now, control.navigatingUntil ?? 0),
                },
            });

            return;
        }

        // A renewal: the lease goes on, under the claim of the view that still holds it. That view closed while this
        // one was minted (`handBack` dropped `renewing`): no view holds the lease, which ends the way that view closed.
        if (previousClaim !== undefined) {
            await patchRow(ctx.db, "browserSessions", session, {
                control:
                    control.renewing === previousClaim
                        ? { ...settled(control), claim: previousClaim }
                        : {
                              ...settled(control),
                              ended: control.renewingEnded ?? ("left" as const),
                              until: Math.max(ctx.now, control.navigatingUntil ?? 0),
                          },
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
 * A renewal's mint came back and was checked: the lease is this claim's alone from now on (`renewing` goes). `false`:
 * the lease is no longer this claim's, or was handed back or lapsed meanwhile, and no URL may be returned.
 *
 * `ownView`: the renewal refreshes the view that holds the claim it replaced (not another of the person's tabs taking
 * over). That view closed while it was minted (`renewingEnded`): nothing would show the new view, so the lease ends the
 * way that view closed, as its hand back would have ended it.
 */
export const settleControlClaim = internalMutation
    .input({ claim: v.string(), ownView: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args: { claim, ownView, threadId }, ctx }) => {
        const session = await activeThreadSession(ctx.db, threadId);
        const control = session?.control;

        if (session === null || control?.claim !== claim || control.ended !== undefined || controlStateOf(session, ctx.now) !== "person") {
            return false;
        }

        if (ownView === true && control.renewingEnded !== undefined) {
            await patchRow(ctx.db, "browserSessions", session, {
                ...activeNow(session, ctx.now),
                control: { ...settled(control), ended: control.renewingEnded, until: Math.max(ctx.now, control.navigatingUntil ?? 0) },
            });

            return false;
        }

        await patchRow(ctx.db, "browserSessions", session, { control: settled(control) });

        return true;
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
    /** `renews`: the claim of the view this refreshes (its URL expired unconnected), so a renewal is told from a takeover. */
    .input({ renews: v.optional(v.string().max(MAX_LENGTH.short)), threadId: v.id("threads") })
    .use(rateLimit("browser/liveView"))
    .output(
        v.union(
            /**
             * `claim` names this lease: the view passes it to `keepControl`, `handBack` and `navigateInControl`. `until`:
             * when the lease ends unrenewed, on the server's clock, so the view need not wait for a status read to know.
             * `claimId`: the claim's public name, as the live status shows it. `release`: the token a closing page sends
             * to `POST /browser/release` (a beacon carries no session), good for this claim's lease alone.
             */
            v.object({
                claim: v.string(),
                claimId: v.string(),
                connectBy: v.number(),
                release: v.optional(v.string()),
                status: v.literal("ok"),
                until: v.number(),
                url: v.string(),
            }),
            v.object({ status: v.union(v.literal("busy"), v.literal("ended"), v.literal("taken"), v.literal("unavailable")) }),
        ),
    )
    .action(async ({ args: { renews, threadId }, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        refuseImpersonation(impersonatedBy);

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

        // A renewal's failed mint leaves the lease to the view that holds it (the person is still at work there), and one
        // that took back a lease they had handed back hands it back again.
        const drop = async (): Promise<void> => {
            await ctx.runMutation(internal.browser.live_view.dropControlClaim, {
                claim: claim.claim,
                threadId,
                userId,
                ...(claim.handedBack !== undefined && { handedBack: claim.handedBack }),
                ...(claim.previousClaim !== undefined && { previousClaim: claim.previousClaim }),
                ...(claim.returned !== undefined && { returned: claim.returned }),
            });
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
        // over, renewed by another of the caller's tabs or lapsed, or a browser replaced while it ran gets no URL.
        const after = await ctx
            .runQuery(internal.browser.live_view.getReaderBrowser, { at: Date.now(), claim: claim.claim, threadId, userId })
            .catch(async (error: unknown) => {
                // No URL leaves this call: the claim goes as on any other failure, and the error with it.
                await drop();

                throw error;
            });

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

        // A renewal is done: the claim it replaced goes, so the view that held it is told to close.
        if (claim.previousClaim !== undefined) {
            const held = await ctx
                .runMutation(internal.browser.live_view.settleControlClaim, {
                    claim: claim.claim,
                    threadId,
                    ...(renews !== undefined && renews === claim.previousClaim && { ownView: true }),
                })
                .catch(async (error: unknown) => {
                    await drop();

                    throw error;
                });

            if (!held) {
                return await refuse("unavailable", "lease_ended_after_mint");
            }
        }

        ctx.log.event("browser.control_taken", { ok: true, reason: claim.fresh ? "fresh" : "renewed" });

        const release = await releaseTokenFor({ claim: claim.claim, shardKey: claim.shardKey, threadId });

        return {
            claim: claim.claim,
            claimId: await claimIdOf(claim.claim),
            connectBy: Date.now() + LIVE_VIEW_CONNECT_DEADLINE_MS,
            ...(release !== undefined && { release }),
            status: "ok" as const,
            until: claim.until,
            url,
        };
    });

/**
 * The person in control gave input: the idle timeout starts again. `null`: they no longer hold control (or may not), or
 * `claim` is not the lease's: another of their tabs took control since, and this view must close.
 */
export const keepControl = authMutation
    .input({ claim: v.string().max(MAX_LENGTH.short), threadId: v.id("threads") })
    .use(rateLimit("browser/control"))
    .output(v.union(v.null(), v.object({ until: v.number() })))
    .mutation(async ({ args: { claim, threadId }, ctx }) => {
        refuseImpersonation(ctx.user.impersonatedBy);

        const browser = await readerBrowser(ctx, threadId, ctx.user.userId, ctx.now, { primary: true });
        const control = browser.kind === "watchable" ? browser.session.control : undefined;

        // A lease handed back while the person's page still loads is over: it is not renewed.
        if (
            browser.kind !== "watchable" ||
            !browser.canControl ||
            browser.control?.byCaller !== true ||
            !claimNames(control, claim) ||
            control.ended !== undefined
        ) {
            return null;
        }

        const until = ctx.now + CONTROL_IDLE_MS;

        await patchRow(systemDb(ctx), "browserSessions", browser.session, {
            ...activeNow(browser.session, ctx.now),
            control: { ...control, until },
        });

        return { until };
    });

/**
 * Ends the lease `claim` names, the way its view closed, as {@link handBack} does. `again`: a send again of a hand back
 * that already landed; `renewing`: the view a renewal is replacing closed, which only records how; `undefined`: the
 * lease is not that claim's (another person's, a newer claim, or lapsed), or `isHolder` refused it.
 */
const returnLease = async (
    db: Parameters<typeof patchRow>[0],
    session: Doc<"browserSessions"> | null,
    claim: string,
    reason: "handed_back" | "left",
    now: number,
    isHolder: (session: Doc<"browserSessions">) => Promise<boolean>,
): Promise<"again" | "ended" | "renewing" | undefined> => {
    // A send again of a hand back that already landed (its answer did not get through): it changes nothing.
    if (session?.control?.claim === claim && (session.control.ended === "handed_back" || session.control.ended === "left") && (await isHolder(session))) {
        return "again";
    }

    if (session === null || !claimNames(session.control, claim) || controlStateOf(session, now) !== "person" || !(await isHolder(session))) {
        return undefined;
    }

    // A view a renewal is replacing closed: the renewal decides (another tab of the person's may be taking over), and
    // ends the lease the way this view closed if it fails, as no view holds it then.
    if (session.control.claim !== claim) {
        await patchRow(db, "browserSessions", session, { control: { ...settled(session.control), renewingEnded: reason } });

        return "renewing";
    }

    // A page the person asked for is still loading: the agent waits for it too, then the lease ends with it.
    const until = Math.max(now, session.control.navigatingUntil ?? 0);

    await patchRow(db, "browserSessions", session, { ...activeNow(session, now), control: { ...session.control, ended: reason, until } });

    return "ended";
};

/**
 * The person gives the browser back (`handed_back`) or left the view (`left`); the agent's next action is told. Takes
 * no thread decision and no rate limit: it only ends the caller's own lease, and only the one `claim` names, so an
 * older tab of theirs closing never ends the lease a newer tab took. Answers whether that claim's lease is handed back
 * now (also when an earlier send of the same hand back ended it): `false` when it was no longer the claim's (another
 * of the person's tabs took over, or the lease ran out), so the view does not say it handed anything back.
 */
export const handBack = authMutation
    .input({ claim: v.string().max(MAX_LENGTH.short), reason: v.union(v.literal("handed_back"), v.literal("left")), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args: { claim, reason, threadId }, ctx }) => {
        const db = systemDb(ctx);
        const ended = await returnLease(
            db,
            await activeThreadSession(db, threadId),
            claim,
            reason,
            ctx.now,
            async (session) => await holdsLease(session, ctx.user.userId),
        );

        if (ended === "ended") {
            ctx.log.event("browser.control_returned", { reason });
        }

        return ended === "ended" || ended === "again";
    });

/**
 * A closing page's hand back (`POST /browser/release`), which carries no session: the route verified the release token
 * `takeControl` gave the claim's holder alone, and this runs on the shard it names. It ends only the lease that claim
 * names, as `handBack` would: `left`, or `handed_back` for a page that closed while the person's own hand back was
 * still out. A newer claim, or a lease already ended, is left as it is.
 */
export const releaseControl = internalMutation
    .input({ claim: v.string(), reason: v.union(v.literal("handed_back"), v.literal("left")), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args: { claim, reason, threadId }, ctx }) => {
        const ended = await returnLease(ctx.db, await activeThreadSession(ctx.db, threadId), claim, reason, ctx.now, async () => true);

        if (ended === "ended") {
            ctx.log.event("browser.control_returned", { reason });
        }

        return ended === "ended" || ended === "again";
    });

/**
 * The person in control opens a page: through the renderer, so the same checks as the agent's `navigate` apply (the
 * thread owner's browser setting and domain lists for the address typed, and the renderer's guard against private
 * and metadata addresses for every request, redirects included). The lists are not a boundary for the person: the
 * interactive view lets them follow any link, so a redirect is no different from a click.
 */
export const navigateInControl = authAction
    .input({ claim: v.string().max(MAX_LENGTH.short), threadId: v.id("threads"), url: v.string().max(2048) })
    .use(rateLimit("browser/control"))
    .output(
        v.union(
            v.object({ status: v.literal("ok"), url: v.optional(v.string()) }),
            /** The thread's browser was closed or replaced while the page loaded: what loaded is no longer the browser in the view. */
            v.object({ status: v.literal("closed") }),
            v.object({ error: v.string(), status: v.literal("refused") }),
        ),
    )
    .action(async ({ args: { claim, threadId, url }, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        refuseImpersonation(impersonatedBy);

        if (!isServiceBound(ctx, "browserRenderer")) {
            return { error: "Browser automation is not configured.", status: "refused" as const };
        }

        const navigation = await ctx.runMutation(internal.browser.live_view.beginControlNavigation, { at: Date.now(), claim, threadId, url, userId });

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
        const budget = rendererCallBudget(navigation.navigatingUntil, startedAt);
        const signal = budget === 0 ? undefined : AbortSignal.timeout(budget);
        const { data, error, response } =
            signal === undefined
                ? { data: undefined, error: undefined, response: undefined }
                : await browserAction({
                      body: { action: "navigate", sessionId: navigation.providerSessionId, url },
                      client,
                      signal,
                  }).catch(() => {
                      return { data: undefined, error: undefined, response: undefined };
                  });
        const result = data as BrowserActionResponse | undefined;
        // The renderer retired the browser for good: the row forgets it, so the next action opens a new one.
        const isRetired = response?.status === 410;
        // The renderer lost the call's hold while the page loaded (a 503 that ran something): the page may have opened,
        // and the browser it names (a new one, when the row's could not be reconnected) stays the row's.
        const withheld =
            response?.status === 503 && response.headers?.get?.("x-browser-action") !== "not-run"
                ? ((error ?? {}) as { error?: unknown; sessionId?: unknown })
                : undefined;
        const withheldSessionId = typeof withheld?.sessionId === "string" ? withheld.sessionId : undefined;
        const withheldError = typeof withheld?.error === "string" ? withheld.error : undefined;

        // A call cut off at its deadline may still be loading the page in the renderer: its hold runs out on its own, so
        // the agent never acts while it lands. The signal, as the clock may lag the timer that fired it.
        const mayStillLoad = signal !== undefined && result === undefined && (signal.aborted || Date.now() >= startedAt + budget);

        // The audit row, on the row the navigation began on, and a browser the renderer replaced or closed (a blocked
        // redirect closes it and answers no id: nothing is left to watch). Not the session's page: others who watch the
        // chat read that, and what the person opens is theirs; only the owner's history shows it, and whether they or a collaborator opened it. Before the lease's hold ends, so the agent
        // never acts on a row that still names a browser that is gone. A failed write never keeps the hold: the agent's
        // next action finds a browser that is gone on its own path, as it does one the provider reaped.
        let logged: { replaced: boolean } | undefined;

        try {
            try {
                logged = await ctx.runMutation(internal.browser.functions.logAction, {
                    action: "navigate",
                    actor: navigation.byOwner ? "owner" : "collaborator",
                    durationMs: Date.now() - startedAt,
                    ...(result?.success !== true && { errorMessage: result?.error ?? withheldError ?? "The page could not be opened." }),
                    ...((result !== undefined || isRetired) && { providerSessionId: result?.sessionId ?? NO_PROVIDER_SESSION }),
                    ...(withheldSessionId !== undefined && { providerSessionId: withheldSessionId }),
                    sessionId: navigation.sessionId,
                    startedAt,
                    startedWithProviderSessionId: navigation.providerSessionId,
                    success: result?.success === true,
                    target: url,
                });
            } finally {
                if (!mayStillLoad) {
                    await ctx.runMutation(internal.browser.live_view.endControlNavigation, {
                        at: Date.now(),
                        navigatingUntil: navigation.navigatingUntil,
                        sessionId: navigation.sessionId,
                        userId,
                    });
                }
            }
        } finally {
            // The renderer opened nothing (the session was retired, or its lock refused the call): the person's charge for
            // this navigation is given back, as the agent's is (`chat/tools/browser-node.ts`). After the row is logged and
            // the hold ended, whether or not those writes succeed, and a refund that fails is let go: it never keeps a
            // hold or a retired browser on the row, nor hides their error.
            if (isRetired || response?.headers?.get?.("x-browser-action") === "not-run") {
                await ctx
                    .runMutation(internal.lib.rate_limiter_mutations.refundRateLimit, {
                        identifier: userId,
                        key: getRateLimitKey("browser/control", getUserTier({ plan: ctx.user.plan })),
                    })
                    .catch(() => undefined);
            }
        }

        // The row was closed or moved on to another browser meanwhile (`replaced` covers both), or the renderer opened
        // the page in a new browser (the old one expired), which ended the lease: the person's view shows a browser gone.
        if (
            logged?.replaced === true ||
            isRetired ||
            (result?.success === true && (result.sessionId ?? NO_PROVIDER_SESSION) !== navigation.providerSessionId) ||
            (withheldSessionId !== undefined && withheldSessionId !== navigation.providerSessionId)
        ) {
            return { status: "closed" as const };
        }

        if (result?.success !== true) {
            return { error: result?.error ?? withheldError ?? "The page could not be opened.", status: "refused" as const };
        }

        return { status: "ok" as const, ...(result.url !== undefined && { url: result.url }) };
    });

/**
 * The person in control starts opening a page: only while they hold the lease `claim` names (not handed back), may write in the
 * thread, the owner has not turned browsing off or listed the address, and no page they asked for still loads. The
 * lease lasts at least as long as the renderer call (`rendererCallHold`: the call may start a little later and is
 * cut off before the hold ends), and a hand back meanwhile waits for it ({@link handBack}), so the agent never acts
 * while the page the person asked for loads. `navigatingUntil` names this navigation. `at`: the action's clock, as in
 * `getReaderBrowser`, so a lease that lapsed since the action started is over.
 */
export const beginControlNavigation = internalMutation
    .input({ at: v.optional(v.number()), claim: v.string(), threadId: v.id("threads"), url: v.string(), userId: v.string() })
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
    .mutation(async ({ args: { at, claim, threadId, url, userId }, ctx }) => {
        const now = Math.max(ctx.now, at ?? 0);
        const browser = await readerBrowser(ctx, threadId, userId, now, { primary: true });

        if (browser.kind === "denied") {
            return { kind: "denied" as const };
        }

        const control = browser.kind === "watchable" ? browser.session.control : undefined;

        if (
            browser.kind !== "watchable" ||
            !browser.canControl ||
            browser.control?.byCaller !== true ||
            !claimNames(control, claim) ||
            control.ended !== undefined
        ) {
            return { kind: "refused" as const };
        }

        // One page at a time: a second would end its hold when the first one loads, while it still runs.
        if ((control.navigatingUntil ?? 0) > now) {
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

        const navigatingUntil = rendererCallHold(now);

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

/**
 * The person's page loaded (or failed): a lease handed back meanwhile ends now, and one still held starts a fresh idle
 * window, so the person is not cut off the moment the page they opened appears. Only that navigation's own hold ends,
 * and a lease that lapsed meanwhile, or whose holder may no longer write in the chat, is not renewed. `at`: the action's clock once the page loaded (see `getReaderBrowser`).
 */
export const endControlNavigation = internalMutation
    .input({ at: v.optional(v.number()), navigatingUntil: v.number(), sessionId: v.id("browserSessions"), userId: v.string() })
    .mutation(async ({ args: { at, navigatingUntil, sessionId, userId }, ctx }) => {
        const now = Math.max(ctx.now, at ?? 0);
        const session = await ctx.db.get("browserSessions", sessionId);
        const control = session?.control;

        if (!session || control?.navigatingUntil !== navigatingUntil || !(await holdsLease(session, userId))) {
            return;
        }

        if (control.ended !== undefined) {
            // `undefined` removes the deadline: the page loaded.
            await patchRow(ctx.db, "browserSessions", session, { control: { ...control, navigatingUntil: undefined, until: Math.min(control.until, now) } });

            return;
        }

        // Renewed like `keepControl`: only while the person may still drive the browser.
        const reader = control.until > now ? await readerBrowser(ctx, session.threadId, userId, now, { primary: true }) : undefined;
        const held = reader?.kind === "watchable" && reader.canControl && reader.session._id === sessionId;

        await patchRow(ctx.db, "browserSessions", session, {
            ...(held && activeNow(session, now)),
            control: { ...control, navigatingUntil: undefined, until: held ? Math.max(control.until, now + CONTROL_IDLE_MS) : control.until },
        });
    });
