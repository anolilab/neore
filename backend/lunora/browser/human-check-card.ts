/**
 * The "Needs you" card's own answer (`browser/human-check.ts`): the person marks the check done or declines it, once.
 * The card reads the ask by its id, which the browser tool's result carries; the row says only the site and its state,
 * never the browser's connect URL or session id. Who may answer is who may take control of the browser
 * (`live-view.ts`): a reader with write access, never while impersonating.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { meetsThreadPermission, resolveThreadReadAccess } from "../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { patchRow } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
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

/**
 * The ask `checkId` of `threadId`, read past row-level security (the row is the owner's) once the caller reads the
 * thread right now in full (owner or live grantee, not locked, not trashed): `null` otherwise, or when the id is of
 * another thread.
 */
const readableCheck = async (
    ctx: QueryCtx,
    threadId: Id<"threads">,
    checkId: Id<"browserHumanChecks">,
    userId: string,
    options: { primary?: boolean } = {},
): Promise<{ canWrite: boolean; row: Doc<"browserHumanChecks"> } | null> => {
    const access = await resolveThreadReadAccess(ctx, threadId, userId, undefined, options);

    if (access?.kind !== "full" || access.thread.deleted === true) {
        return null;
    }

    const row = await systemDb(ctx).get("browserHumanChecks", checkId);

    if (row === null || row.threadId !== threadId) {
        return null;
    }

    return { canWrite: meetsThreadPermission(access.permission, "write"), row };
};

/**
 * The ask's state for its card: `canResolve` when the caller may answer it now, `expiresAt` when an unanswered one
 * expires, on the server's clock (`now`, this answer's time). `null`: no such ask they can read.
 */
export const getHumanCheck = authQuery
    .input({ checkId: v.id("browserHumanChecks"), threadId: v.id("threads") })
    .output(v.union(v.null(), v.object({ canResolve: v.boolean(), expiresAt: v.number(), now: v.number(), site: v.string(), status: vCheckStatus })))
    .query(async ({ args: { checkId, threadId }, ctx }) => {
        const check = await readableCheck(ctx, threadId, checkId, ctx.user.userId);

        if (check === null) {
            return null;
        }

        const status = humanCheckStatusOf(check.row, ctx.now);

        // A live query re-runs on a write, not on the clock: `expiresAt` lets the card close an ask nobody answered.
        return {
            canResolve: status === "open" && check.canWrite && !ctx.user.impersonatedBy,
            expiresAt: check.row.askedAt + HUMAN_CHECK_HAND_BACK_WINDOW_MS,
            now: ctx.now,
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
    .input({ checkId: v.id("browserHumanChecks"), resolution: v.union(v.literal("declined"), v.literal("done")), threadId: v.id("threads") })
    .use(rateLimit("browser/control"))
    .output(v.object({ changed: v.boolean(), status: vCheckStatus }))
    .mutation(async ({ args: { checkId, resolution, threadId }, ctx }) => {
        refuseImpersonation(ctx.user.impersonatedBy);

        // The grant from the primary: a collaborator whose write access was just removed answers nothing.
        const check = await readableCheck(ctx, threadId, checkId, ctx.user.userId, { primary: true });

        if (check === null || !check.canWrite) {
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
