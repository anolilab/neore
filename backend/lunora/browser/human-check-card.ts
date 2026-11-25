/**
 * The "Needs you" card's own answer (`browser/human-check.ts`): the person marks the check done or declines it, once.
 * The card reads the ask by its id, site and reply (`run`), which the browser tool's result carries; the row says only the site and its state,
 * never the browser's connect URL or session id. Who may answer is who may take control of the browser
 * (`live-view.ts`): a reader with write access, never while impersonating.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { lastGrantRevision } from "../agent/grant-revision";
import { meetsThreadPermission, resolveThreadReadAccess } from "../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { patchRow } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { HUMAN_CHECK_HAND_BACK_WINDOW_MS } from "./human-check";
import { refuseImpersonation } from "./live-view";

type CheckStatus = "declined" | "done" | "expired" | "open";

const vCheckStatus = v.union(v.literal("declined"), v.literal("done"), v.literal("expired"), v.literal("open"));

/** An answer stands; an unanswered ask older than the hand-back window is no longer about the page the person sees. */
export const humanCheckStatusOf = (row: Pick<Doc<"browserHumanChecks">, "askedAt" | "resolution">, now: number): CheckStatus => {
    if (row.resolution !== undefined) {
        return row.resolution;
    }

    return row.askedAt + HUMAN_CHECK_HAND_BACK_WINDOW_MS < now ? "expired" : "open";
};

/** The ask's identity on the card: its id, and the site and reply (`run`) the result names, of the thread the card is in. */
interface CheckRef {
    checkId: Id<"browserHumanChecks">;
    run: string;
    site: string;
    threadId: Id<"threads">;
}

/**
 * The ask `checkId` of `threadId`, read past row-level security (the row is the owner's) once the caller reads the
 * thread right now in full (owner or live grantee, not locked, not trashed): `denied` when they do not; `row: null` when
 * they do but the id is of no ask of this thread on that site and reply (a branched chat's copied result names its parent's
 * ask). The row is found by this thread's unique key for the site and reply, never by id: a read by id would put another
 * thread's row in a live query's read set, and its answer would re-run the branch's query, which tells the branch's
 * reader when the parent's check was answered. The full key reads one row at most, however many asks the site had.
 */
const readableCheck = async (
    ctx: QueryCtx,
    { checkId, run, site, threadId }: CheckRef,
    userId: string,
    options: { primary?: boolean } = {},
): Promise<
    { accessUntil?: number; canWrite: boolean; kind: "reads"; revision?: number; row: Doc<"browserHumanChecks"> | null } | { kind: "denied"; revision?: number }
> => {
    let access = await resolveThreadReadAccess(ctx, threadId, userId, undefined, options);

    if (access?.kind !== "full" && access?.thread.userId !== userId && options.primary !== true) {
        // A grantee's denial is decided on the primary (a re-grant a replica has not seen yet reads as the grant), and
        // the count is read after it, so the revision it names is at least as new as the denial.
        access = await resolveThreadReadAccess(ctx, threadId, userId, undefined, { primary: true });

        if (access?.kind !== "full") {
            const last = access?.thread.userId === userId ? undefined : await lastGrantRevision(ctx, threadId, userId);

            return last === undefined ? { kind: "denied" } : { kind: "denied", revision: last };
        }
    }

    if (access?.kind !== "full" || access.thread.deleted === true) {
        // The grant's revision this read saw, or its last one once no grant reads; the owner holds none.
        if (access?.thread.userId === userId) {
            return { kind: "denied" };
        }

        const revision = access?.kind === "full" ? access.revision : await lastGrantRevision(ctx, threadId, userId);

        return revision === undefined ? { kind: "denied" } : { kind: "denied", revision };
    }

    // The unique key of the reply's ask on the site in this thread; a missing ask and another thread's alike are `null`.
    const ask = await systemDb(ctx)
        .query("browserHumanChecks")
        .withIndex("by_threadId_site_run", (q) => q.eq("threadId", threadId).eq("site", site).eq("run", run))
        .first();
    const row = ask?._id === checkId ? ask : null;

    return {
        ...(access.expiresAt !== undefined && { accessUntil: access.expiresAt }),
        canWrite: meetsThreadPermission(access.permission, "write"),
        kind: "reads",
        ...(access.revision !== undefined && { revision: access.revision }),
        row,
    };
};

/**
 * The ask's state for its card: `canResolve` when the caller may answer it now, `expiresAt` when an unanswered one
 * expires, `accessUntil` when a grantee's grant ends (the card then shows nothing and reads again, which answers
 * `none`), both on the server's clock (`now`, this answer's time). `kind: "none"`: the caller does not read the thread in
 * full now, with only the server's clock, so a client orders it against its other reads. `kind: "elsewhere"`: they do,
 * but the id is of no ask of this thread (a branched chat's copy of its parent's result): the card keeps the page it
 * shows and offers no answer; it carries the grant's end like `found`. `revision`, on every answer to a grantee: their
 * grant's revision as the read saw it, as on `getThreadBrowser`.
 */
export const getHumanCheck = authQuery
    .input({ checkId: v.id("browserHumanChecks"), run: v.string().max(MAX_LENGTH.key), site: v.string().max(MAX_LENGTH.short), threadId: v.id("threads") })
    .output(
        v.union(
            v.object({ kind: v.literal("none"), now: v.number(), revision: v.optional(v.number()) }),
            v.object({ accessUntil: v.optional(v.number()), kind: v.literal("elsewhere"), now: v.number(), revision: v.optional(v.number()) }),
            v.object({
                accessUntil: v.optional(v.number()),
                canResolve: v.boolean(),
                expiresAt: v.number(),
                kind: v.literal("found"),
                now: v.number(),
                revision: v.optional(v.number()),
                site: v.string(),
                status: vCheckStatus,
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const check = await readableCheck(ctx, args, ctx.user.userId);
        const revision = check.revision === undefined ? {} : { revision: check.revision };

        if (check.kind === "denied") {
            return { kind: "none" as const, now: ctx.now, ...revision };
        }

        if (check.row === null) {
            return { ...(check.accessUntil !== undefined && { accessUntil: check.accessUntil }), kind: "elsewhere" as const, now: ctx.now, ...revision };
        }

        const status = humanCheckStatusOf(check.row, ctx.now);

        // A live query re-runs on a write, not on the clock: `expiresAt` lets the card close an ask nobody answered,
        // `accessUntil` a grant that ended.
        return {
            ...(check.accessUntil !== undefined && { accessUntil: check.accessUntil }),
            canResolve: status === "open" && check.canWrite && !ctx.user.impersonatedBy,
            expiresAt: check.row.askedAt + HUMAN_CHECK_HAND_BACK_WINDOW_MS,
            kind: "found" as const,
            now: ctx.now,
            ...revision,
            site: check.row.site,
            status,
        };
    });

/**
 * The person's answer: `done` (they cleared it) or `declined`. Set once: an ask already answered, by this tab or
 * another, keeps its answer and reports it (`changed: false`), and so does one past its window (`expired`). The
 * agent hears the answer at its next look at the site, or in `wait_for_person` (`chat/tools/browser.ts`).
 */
export const resolveHumanCheck = authMutation
    .input({
        checkId: v.id("browserHumanChecks"),
        resolution: v.union(v.literal("declined"), v.literal("done")),
        run: v.string().max(MAX_LENGTH.key),
        site: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
    })
    .use(rateLimit("browser/control"))
    .output(v.object({ changed: v.boolean(), status: vCheckStatus }))
    .mutation(async ({ args: { checkId, resolution, run, site, threadId }, ctx }) => {
        refuseImpersonation(ctx.user.impersonatedBy);

        // The grant from the primary: a collaborator whose write access was just removed answers nothing.
        const check = await readableCheck(ctx, { checkId, run, site, threadId }, ctx.user.userId, { primary: true });

        if (check.kind === "denied" || !check.row || !check.canWrite) {
            throwForbidden("Only someone who can write in this chat can answer this check.");
        }

        const status = humanCheckStatusOf(check.row, ctx.now);

        if (status !== "open") {
            return { changed: false, status };
        }

        await patchRow(systemDb(ctx), "browserHumanChecks", check.row, { resolution, resolvedAt: ctx.now });
        ctx.log.event("browser.human_check_resolved", { resolution });

        return { changed: true, status: resolution };
    });
