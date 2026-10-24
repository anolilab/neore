/**
 * One unit of a user's DAILY generation quota, charged from background work.
 *
 * The HTTP routes charge through `lib/daily-limit.ts#chargeDailyLimit` with
 * the session user in hand. Work that runs later — the extra replies of a
 * group turn, a messenger voice note's transcription — has only a user id, so
 * this resolves the tier from the user row (and, for a turn run in an
 * organization, that organization's paid plan while they are still a member)
 * and charges the same keys.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { getMembersByUserId, getOrganization, getUser } from "../auth/lib/better-auth-queries";
import { resolveUserPlan } from "../auth/lib/plan";
import { claimOnce, releaseClaim } from "../lib/claim-once";
import { createRatelimit } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { dailyLimitKeyOf, dailyLimitTierOf } from "./lib/daily-limit";

/** The claim scope of a unit taken for one request (`requestId`). */
export const DAILY_CHARGE_SCOPE = "daily-charge";

/** A retry of the same request must find its unit still claimed: it outlasts any retry of one run node. */
const DAILY_CHARGE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Charge `count` units (default one) of `kind` to `userId`'s daily quota, all or nothing. `false` when they
 * do not all fit, the tier may not generate `kind` at all, or the user is gone — the caller stops there.
 * Platform admins are exempt, as on the HTTP routes.
 *
 * With a `requestId` the units are taken once per request: a retry of the same request returns `true`
 * without a second charge. The claim and the units are one transaction, and a refused charge releases its
 * claim, so a retry after a refusal is charged normally.
 */
export const chargeDailyUnit = internalMutation
    .input({
        count: v.optional(v.number()),
        kind: v.union(v.literal("Audio"), v.literal("Image"), v.literal("Text"), v.literal("Video")),
        organizationId: v.optional(v.string()),
        requestId: v.optional(v.string().max(MAX_LENGTH.long)),
        userId: v.string(),
    })
    .output(v.boolean())
    .mutation(async ({ args: { count = 1, kind, organizationId, requestId, userId }, ctx }) => {
        const user = await getUser(ctx, userId);

        if (!user) {
            return false;
        }

        if (user.role === "admin") {
            return true;
        }

        let organization = null;

        if (organizationId) {
            const memberships = await getMembersByUserId(ctx, userId);
            const isMember = memberships.some((member) => member.organizationId === organizationId);

            organization = isMember ? await getOrganization(ctx, organizationId) : null;
        }

        const plan = resolveUserPlan(user, [organization]);

        const key = dailyLimitKeyOf(kind, dailyLimitTierOf({ isAnonymous: user.isAnonymous === true, plan, role: user.role ?? null }));

        if (!key) {
            return false;
        }

        // A request whose unit is already claimed was charged by an earlier attempt: it is not charged again.
        if (requestId !== undefined && !(await claimOnce(ctx, DAILY_CHARGE_SCOPE, requestId, DAILY_CHARGE_CLAIM_TTL_MS, userId))) {
            return true;
        }

        const limiter = createRatelimit(key, ctx.db as never);
        const units = Math.max(1, Math.trunc(count));
        // Checked before the limiter, which throws rather than refuses a count above its capacity.
        const { remaining } = await limiter.getRemaining(userId);
        const { ok } = units <= remaining ? await limiter.limit(userId, { count: units }) : { ok: false };

        if (!ok && requestId !== undefined) {
            await releaseClaim(ctx, DAILY_CHARGE_SCOPE, requestId);
        }

        return ok;
    });
