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
import { createRatelimit } from "../lib/rate-limiter";
import { dailyLimitKeyOf, dailyLimitTierOf } from "./lib/daily-limit";

/**
 * Charge one unit of `kind` to `userId`'s daily quota. `false` when it is
 * spent, the tier may not generate `kind` at all, or the user is gone — the
 * caller stops there. Platform admins are exempt, as on the HTTP routes.
 */
export const chargeDailyUnit = internalMutation
    .input({ kind: v.union(v.literal("Audio"), v.literal("Text")), organizationId: v.optional(v.string()), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args: { kind, organizationId, userId }, ctx }) => {
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

        const { ok } = await createRatelimit(key, ctx.db as never).limit(userId);

        return ok;
    });
