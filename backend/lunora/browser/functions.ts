/**
 * Browser Session Management Functions
 *
 * Internal mutations for creating, updating, and querying browser sessions.
 * Phase 2 adds extension pairing and management functions.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";
import { encryptKey } from "../lib/encryption";
import { patchRow, withoutUndefined } from "../lib/patch";
import { currentShard, ROOT_SHARD_KEY } from "../lib/shard-context";
import { controlStateOf, watchableSessionId } from "./live-view-logic";
// ── Utility ─────────────────────────────────────────────────────────────

/** Generate a cryptographically random 8-character uppercase pairing code. */
const generatePairingCode = (): string => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    const randomBytes = new Uint8Array(8);

    crypto.getRandomValues(randomBytes);
    let code = "";

    for (let i = 0; i < 8; i += 1) {
        code += chars[randomBytes[i]! % chars.length];
    }

    return code;
};

/**
 * The thread's one active browser session: the agent's actions and the live view both read this row, so a viewer
 * always watches the browser the agent drives. {@link createSession} never adds a second one; were there two, both
 * readers still agree on the oldest.
 */
export const activeThreadSession = async (db: QueryCtx["db"], threadId: Id<"threads">): Promise<Doc<"browserSessions"> | null> =>
    await db
        .query("browserSessions")
        .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
        .first();

export const getActiveSession = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(async ({ args: { threadId }, ctx }) => await activeThreadSession(ctx.db, threadId));

/** The owner's allowed and blocked domains for the agent's browser (`aiUserPreferences.browserSettings`), for `validateDomain`. */
export const getBrowserDomainSettings = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ domainAllowlist: v.optional(v.array(v.string())), domainBlocklist: v.optional(v.array(v.string())), enabled: v.optional(v.boolean()) }))
    .query(async ({ args, ctx }) => {
        const preferences = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .first();

        return preferences?.browserSettings ?? {};
    });

export const createSession = internalMutation
    .input({
        connectUrl: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        source: v.optional(v.string()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { connectUrl, providerSessionId, source, threadId, userId }, ctx }) => {
        const { now } = ctx;
        // Two first actions at once both found no row: the second gets the first's row, whose browser stays the
        // thread's. Its own result names another browser, so `logAction` keeps only its audit row.
        const existing = await activeThreadSession(ctx.db, threadId);

        if (existing) {
            return existing._id;
        }

        // Encrypt the CDP connect URL before persisting — it contains session credentials
        const encryptedConnectUrl = connectUrl ? await encryptKey(connectUrl, "tool-keys") : undefined;
        const insertedId = await ctx.db.insert("browserSessions", {
            connectUrl: encryptedConnectUrl,
            lastActivityAt: now,
            providerSessionId,
            source: source ?? "browserbase",
            startedAt: now,
            status: "active",
            threadId,
            userId,
        });

        return insertedId as Id<"browserSessions">;
    });

export const updateSession = internalMutation
    .input({
        completedAt: v.optional(v.number()),
        currentUrl: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { sessionId, ...updates }, ctx }) => {
        await ctx.db.patch(
            "browserSessions",
            sessionId,
            withoutUndefined({
                ...updates,
                lastActivityAt: ctx.now,
            }),
        );
    });

/** The holds still ahead of `now`, less one instance of `released` (an action's own hold, when it ends). */
const holdsAfter = (holds: ReadonlyArray<number> | undefined, now: number, released?: number): number[] | undefined => {
    const kept = (holds ?? []).filter((until) => until > now);
    const own = released === undefined ? -1 : kept.indexOf(released);

    if (own !== -1) {
        kept.splice(own, 1);
    }

    return kept.length > 0 ? kept : undefined;
};

/**
 * Both hold lists still ahead of `now`, less the one hold `released` (an action's own) from the list it took it in
 * (`reaped`: `reapedHolds`): the patch every end of an action writes. The list is named, never guessed from the value:
 * two actions that start in the same millisecond have the same deadline.
 */
const holdsReleased = (
    session: Pick<Doc<"browserSessions">, "inUseHolds" | "reapedHolds">,
    now: number,
    released?: { reaped?: boolean; until: number },
): { inUseHolds: number[] | undefined; reapedHolds: number[] | undefined } => {
    return {
        inUseHolds: holdsAfter(session.inUseHolds, now, released?.reaped === true ? undefined : released?.until),
        reapedHolds: holdsAfter(session.reapedHolds, now, released?.reaped === true ? released.until : undefined),
    };
};

/**
 * A browser action is about to run on this session's browser. In one transaction with {@link takeControl}'s claim, so
 * an agent action and a person's control never overlap:
 * - `controlled`: a person drives the browser; the action must not run.
 * - `returned`: a person drove it and gave it back, and the agent has not looked at the page since. Every action
 *   that starts until one has looked hears it (`inspecting` names the lease), so actions side by side all look first;
 *   only {@link logAction} of a look that came back clears it, so a failed or lost one leaves the next to look again.
 * - `held`: every action that runs holds the row until `until` (the renderer call's deadline), so no person takes
 *   control while it acts. On a browser still alive the hold is in `inUseHolds`, and a slow action does not read as
 *   idle; on one the row reads as reaped (the renderer may reconnect to it, or replace it, and {@link logAction} records
 *   the new one) it is in `reapedHolds`, which keeps nothing alive, so the old browser is not offered meanwhile. Each
 *   action adds its own hold beside those of actions still running.
 */
export const beginSessionUse = internalMutation
    .input({ sessionId: v.id("browserSessions"), until: v.number() })
    .output(
        v.object({
            controlled: v.boolean(),
            held: v.boolean(),
            inspecting: v.optional(v.string()),
            /** The hold is in `reapedHolds`: the action names it when it ends ({@link endSessionUse}, {@link logAction}). */
            reaped: v.optional(v.boolean()),
            returned: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("idle"), v.literal("left"))),
        }),
    )
    .mutation(async ({ args: { sessionId, until }, ctx }) => {
        const session = await ctx.db.get("browserSessions", sessionId);

        if (!session || session.status !== "active") {
            return { controlled: false, held: false };
        }

        const control = controlStateOf(session, ctx.now);

        if (control === "person") {
            return { controlled: true, held: false };
        }

        const alive = watchableSessionId(session, ctx.now) !== undefined;
        const inspecting = control === "returned" ? session.control : undefined;
        const holds = holdsReleased(session, ctx.now);

        await patchRow(
            ctx.db,
            "browserSessions",
            session,
            alive ? { ...holds, inUseHolds: [...(holds.inUseHolds ?? []), until] } : { ...holds, reapedHolds: [...(holds.reapedHolds ?? []), until] },
        );

        return {
            controlled: false,
            held: true,
            ...(!alive && { reaped: true }),
            ...(inspecting !== undefined && { inspecting: inspecting.claim, returned: inspecting.ended ?? ("idle" as const) }),
        };
    });

/**
 * The action failed: its own hold ends, and the row is back to its last confirmed activity. Nothing is stamped, and
 * the hold of another action still running stays.
 */
export const endSessionUse = internalMutation
    .input({ reaped: v.optional(v.boolean()), sessionId: v.id("browserSessions"), until: v.number() })
    .mutation(async ({ args: { reaped, sessionId, until }, ctx }) => {
        const session = await ctx.db.get("browserSessions", sessionId);

        if (session) {
            await patchRow(ctx.db, "browserSessions", session, holdsReleased(session, ctx.now, { reaped, until }));
        }
    });

export const logAction = internalMutation
    .input({
        action: v.string(),
        /** The person in control who did this (`navigateInControl`); absent: the agent. */
        actor: v.optional(v.union(v.literal("collaborator"), v.literal("owner"))),
        currentUrl: v.optional(v.string()),
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        /** The hold `heldUntil` names is in `reapedHolds` ({@link beginSessionUse}). */
        heldReaped: v.optional(v.boolean()),
        /** The hold this action took with {@link beginSessionUse}, if it took one. */
        heldUntil: v.optional(v.number()),
        /** The ended lease whose page this action looked at, and the look came back ({@link beginSessionUse}): it is done with. */
        inspected: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        /** When the action started: its page is written only if no action that started later wrote one already. */
        startedAt: v.number(),
        /** The provider session id the row held when the action started (`null`: none), so a stale result is not written. */
        startedWithProviderSessionId: v.union(v.string(), v.null()),
        success: v.boolean(),
        target: v.optional(v.string()),
        value: v.optional(v.string()),
    })
    /**
     * `closed`: the session was closed while this action ran (a later action may already run a fresh browser), so its
     * result is of a browser the thread no longer has.
     * `replaced`: the row moved on to another browser while this action ran, so its result is of a browser the thread
     * no longer uses; `currentUrl` is then the kept browser's page, for the agent to look at again.
     */
    .output(v.object({ closed: v.optional(v.boolean()), currentUrl: v.optional(v.string()), replaced: v.boolean() }))
    .mutation(
        async ({
            args: {
                action,
                actor,
                currentUrl,
                durationMs,
                errorMessage,
                heldReaped,
                heldUntil,
                inspected,
                providerSessionId,
                sessionId,
                startedAt,
                startedWithProviderSessionId,
                success,
                target,
                value,
            },
            ctx,
        }) => {
            await ctx.db.insert("browserActions", {
                action,
                actor,
                durationMs,
                errorMessage,
                sessionId,
                success: success ? 1 : 0,
                target,
                timestamp: ctx.now,
                value,
            });

            const session = await ctx.db.get("browserSessions", sessionId);

            if (!session) {
                return { replaced: false };
            }

            const holds = holdsReleased(session, ctx.now, heldUntil === undefined ? undefined : { reaped: heldReaped, until: heldUntil });

            // Closed while this action ran (the person ended it, or the run did): nothing of this result is the thread's
            // browser any more, and a closed row is never brought back to life.
            if (session.status !== "active") {
                return { closed: true, replaced: true };
            }

            // Another action moved the row to a newer browser while this one ran (it replaced the old browser, or the
            // renderer closed it): this result is about a browser the row no longer names. Only the audit row and the
            // end of its own hold are kept; its id, page and activity would bring the old browser back.
            if ((session.providerSessionId ?? null) !== startedWithProviderSessionId) {
                await patchRow(ctx.db, "browserSessions", session, holds);

                return { ...(session.currentUrl !== undefined && { currentUrl: session.currentUrl }), replaced: true };
            }

            // A browser the renderer replaced (the old one expired, or was closed after a blocked redirect) starts with
            // no page of the old one: `currentUrl` is only what this action reported, or nothing.
            const replaced = providerSessionId !== undefined && providerSessionId !== session.providerSessionId;
            // Two actions on the same browser finish out of order: the page of the one that started later stays.
            const newerPage = currentUrl !== undefined && startedAt >= (session.currentUrlStartedAt ?? -Infinity);
            let page = {};

            if (replaced) {
                page = { currentUrl, currentUrlStartedAt: startedAt, providerSessionId };
            } else if (newerPage) {
                page = { currentUrl, currentUrlStartedAt: startedAt };
            }

            // Every action keeps the provider's browser alive for another idle window; the live view reads this to tell
            // a running browser from one the provider has reaped (`browser/live-view-logic.ts`). This action's hold ends;
            // the holds of actions still running stay.
            // The agent saw the page a person left: the lease is done with (not when the look was of a browser the row no
            // longer names, above: the next action looks again).
            const looked = inspected !== undefined && session.control?.claim === inspected && controlStateOf(session, ctx.now) === "returned";
            // A person's lease is on the browser their view shows: once it is gone, the lease ends with it, and the
            // agent's next action hears that a person drove and that their browser was closed. Also over a hand back
            // made while the page loaded: what the agent needs to know is that the browser it had is gone.
            const leaseEnds = replaced && session.control !== undefined && controlStateOf(session, ctx.now) === "person";

            await patchRow(ctx.db, "browserSessions", session, {
                ...holds,
                // Never back in time: an older action finishing late must not shorten the window a newer one opened.
                lastActivityAt: Math.max(session.lastActivityAt, ctx.now),
                ...page,
                ...(leaseEnds &&
                    session.control !== undefined && {
                        control: { ...session.control, ended: "browser_closed" as const, navigatingUntil: undefined, until: ctx.now },
                    }),
                ...(looked && { control: undefined }),
            });

            return { replaced: false };
        },
    );

export const closeSession = internalMutation
    .input({
        errorMessage: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { errorMessage, sessionId, status }, ctx }) => {
        await ctx.db.patch(
            "browserSessions",
            sessionId,
            withoutUndefined({
                completedAt: ctx.now,
                errorMessage,
                lastActivityAt: ctx.now,
                status: status ?? "completed",
            }),
        );
    });

// ── Human checks (`human-check.ts`) ──────────────────────────────────────

const askKind = (row: { inText?: boolean; reported?: boolean } | null): "detected" | "detected_in_text" | "reported" | null => {
    if (row === null) {
        return null;
    }

    if (row.reported === true) {
        return "reported";
    }

    return row.inText === true ? "detected_in_text" : "detected";
};

/** How the person was asked about `site` in this run, else (with `askedSince`) the thread's latest ask since then; `null` for none. */
export const wasHumanCheckAsked = internalQuery
    .input({ askedSince: v.optional(v.number()), run: v.string(), site: v.string(), threadId: v.id("threads") })
    .output(v.union(v.literal("detected"), v.literal("detected_in_text"), v.literal("reported"), v.null()))
    .query(async ({ args: { askedSince, run, site, threadId }, ctx }) => {
        const inRun = await ctx.db
            .query("browserHumanChecks")
            .withIndex("by_threadId_site_run", (q) => q.eq("threadId", threadId).eq("site", site).eq("run", run))
            .first();

        if (inRun !== null || askedSince === undefined) {
            return askKind(inRun);
        }

        const recent = await ctx.db
            .query("browserHumanChecks")
            .withIndex("by_threadId_site_askedAt", (q) => q.eq("threadId", threadId).eq("site", site).gte("askedAt", askedSince))
            .order("desc")
            .first();

        return askKind(recent);
    });

/**
 * The person is asked about `site` once per run: `true` for the first ask, which records it, `false` when another
 * action of the run asked already. Insert-if-absent on the unique key, with no read first: of two claims at once, the
 * insert that loses answers `false`. The row names the thread's owner, whose shard holds it, whoever's turn asked (a
 * collaborator's id there would outlive their account and escape the owner's erasure); a thread with no owner names
 * the shard it lives on. A thread that is gone asks nobody.
 * A report on a site the run already asked about (a sign-in wall after a check) marks that ask `reported`: what the
 * person handed back then shows no marker either way.
 */
export const claimHumanCheckAsk = internalMutation
    .input({ inText: v.optional(v.boolean()), reported: v.optional(v.boolean()), run: v.string(), site: v.string(), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args: { inText, reported, run, site, threadId }, ctx }) => {
        const thread = await ctx.db.get("threads", threadId);

        if (!thread) {
            return false;
        }

        if (reported === true) {
            const asked = await ctx.db
                .query("browserHumanChecks")
                .withIndex("by_threadId_site_run", (q) => q.eq("threadId", threadId).eq("site", site).eq("run", run))
                .first();

            if (asked !== null) {
                if (asked.reported !== true) {
                    await ctx.db.patch("browserHumanChecks", asked._id, { reported: true });
                }

                return false;
            }
        }

        try {
            await ctx.db.insert("browserHumanChecks", {
                askedAt: ctx.now,
                ...(inText === true && reported !== true && { inText }),
                ...(reported === true && { reported }),
                run,
                site,
                threadId,
                // An ownerless thread (an anonymous one) lives on the shard serving it: the row names that shard's key, and
                // goes with the thread when it is deleted.
                userId: thread.userId ?? currentShard() ?? ROOT_SHARD_KEY,
            });
        } catch (error) {
            if (isUniqueViolation(error)) {
                return false;
            }

            throw error;
        }

        return true;
    });

// ── Browser Extension Functions (Phase 2) ───────────────────────────────

export const createExtensionPairing = internalMutation
    .input({
        userId: v.string(),
    })
    .mutation(async ({ args: { userId }, ctx }) => {
        const code = generatePairingCode();
        const { now } = ctx;
        const insertedId = await ctx.db.insert("browserExtensions", {
            extensionId: `ext_${now}_${ctx.newId()}`,
            pairingCode: code,
            status: "pending",
            userId,
        });

        return { id: insertedId as Id<"browserExtensions">, pairingCode: code };
    });

export const completePairing = internalMutation
    .input({
        browserInfo: v.optional(v.string()),
        capabilities: v.optional(v.array(v.string())),
        extensionId: v.string(),
        extensionVersion: v.optional(v.string()),
        pairingCode: v.string(),
    })
    .mutation(async ({ args: { browserInfo, capabilities, extensionId, extensionVersion, pairingCode }, ctx }) => {
        const extension = await ctx.db
            .query("browserExtensions")
            .withIndex("by_pairingCode", (q) => q.eq("pairingCode", pairingCode))
            .first();

        if (!extension || extension.status !== "pending") {
            return { error: "Invalid or expired pairing code", success: false };
        }

        // `undefined` removes a field here: the one-time code in particular.
        await patchRow(ctx.db, "browserExtensions", extension, {
            browserInfo,
            capabilities,
            extensionId,
            extensionVersion,
            lastSeenAt: ctx.now,
            pairedAt: ctx.now,
            pairingCode: undefined, // Clear the one-time code
            status: "paired",
        });

        return { success: true, userId: extension.userId };
    });

export const getUserExtensions = internalQuery
    .input({
        userId: v.string(),
    })
    .query(
        async ({ args: { userId }, ctx }) =>
            await ctx.db
                .query("browserExtensions")
                .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "paired"))
                .collect(),
    );

export const revokeExtension = internalMutation
    .input({
        extensionDocId: v.id("browserExtensions"),
        userId: v.string(),
    })
    .mutation(async ({ args: { extensionDocId, userId }, ctx }) => {
        const extension = await ctx.db.get("browserExtensions", extensionDocId);

        if (!extension || extension.userId !== userId) {
            return { success: false };
        }

        await ctx.db.patch("browserExtensions", extensionDocId, {
            status: "revoked",
        });

        return { success: true };
    });

export const extensionHeartbeat = internalMutation
    .input({
        extensionId: v.string(),
    })
    .mutation(async ({ args: { extensionId }, ctx }) => {
        const extension = await ctx.db
            .query("browserExtensions")
            .withIndex("by_extensionId", (q) => q.eq("extensionId", extensionId))
            .first();

        if (extension && extension.status === "paired") {
            await ctx.db.patch("browserExtensions", extension._id, {
                lastSeenAt: ctx.now,
            });
        }
    });
