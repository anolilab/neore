/**
 * The per-user DAILY generation quotas the HTTP chat routes charge
 * (`/chat/start`, `/chat/edit`, `/chat/media`), in one place.
 *
 * Each route used to resolve the tier itself off an untyped `user` and build
 * the key as a template string. The plan was read through a cast from a field
 * nothing set, so every paying user drew free-tier limits, and a key naming a
 * config that does not exist is silently ALLOWED by `applyRateLimit` — so the
 * keys are spelled out below, where the compiler checks each one against the
 * table.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { BetterAuthUser } from "../../auth/lib/types";
import { getUserTier, type RateLimitKey } from "../../lib/rate-limiter";

export type DailyLimitKind = "Audio" | "Image" | "Text" | "Video";

export type DailyLimitTier = "anonymous" | "free" | "premium";

/**
 * The config each kind is charged to, per tier. An absent entry is a tier that
 * may not generate that kind at all (guests and video), and is refused.
 */
const DAILY_LIMIT_KEYS: Record<DailyLimitKind, Partial<Record<DailyLimitTier, RateLimitKey>>> = {
    Audio: { anonymous: "chat/dailyAudio:anonymous", free: "chat/dailyAudio:free", premium: "chat/dailyAudio:premium" },
    Image: { anonymous: "chat/dailyImage:anonymous", free: "chat/dailyImage:free", premium: "chat/dailyImage:premium" },
    Text: { anonymous: "chat/dailyText:anonymous", free: "chat/dailyText:free", premium: "chat/dailyText:premium" },
    Video: { free: "chat/dailyVideo:free", premium: "chat/dailyVideo:premium" },
};

type LimitedUser = Pick<BetterAuthUser, "isAnonymous" | "plan" | "role">;

/** Platform admins are exempt from every daily quota. */
export const isPlatformAdmin = (user: Pick<BetterAuthUser, "role">): boolean => user.role === "admin";

/**
 * The tier an HTTP-route user draws on a TIERED limit (`<base>:free|premium`),
 * resolved as the `rateLimit()` middleware resolves `ctx.user`: admins and the
 * paid plan are premium.
 */
export const rateLimitTierOf = (user: Pick<BetterAuthUser, "plan" | "role">): "free" | "premium" =>
    getUserTier({ isAdmin: isPlatformAdmin(user), plan: user.plan ?? null }) === "premium" ? "premium" : "free";

/** Guests first, then the paid plan, then free. */
export const dailyLimitTierOf = (user: LimitedUser): DailyLimitTier => {
    if (user.isAnonymous === true) {
        return "anonymous";
    }

    return getUserTier({ plan: user.plan ?? null }) === "premium" ? "premium" : "free";
};

export const dailyLimitKeyOf = (kind: DailyLimitKind, tier: DailyLimitTier): RateLimitKey | undefined => DAILY_LIMIT_KEYS[kind][tier];

export type DailyLimitResult = { ok: true } | { ok: false; retryAfter?: number };

/**
 * Charge `count` units of `kind` to `user`'s daily quota. With a `chargeKey` (a keyed send's, `startChargeKey`) the units
 * are taken once per key (`chat/daily-charge.ts#chargeDailyLimitOnce`): a retry of a send already charged is not charged again.
 */
export const chargeDailyLimit = async (
    context: Pick<HttpActionCtx, "runMutation">,
    user: LimitedUser & Pick<BetterAuthUser, "_id">,
    kind: DailyLimitKind,
    count = 1,
    { chargeKey }: { chargeKey?: string } = {},
): Promise<DailyLimitResult> => {
    if (isPlatformAdmin(user)) {
        return { ok: true };
    }

    const key = dailyLimitKeyOf(kind, dailyLimitTierOf(user));

    if (!key) {
        return { ok: false };
    }

    const result =
        chargeKey === undefined
            ? await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { count, identifier: user._id, key })
            : await context.runMutation(internal.chat.daily_charge.chargeDailyLimitOnce, { chargeKey, count, identifier: user._id, key });

    return result.ok ? { ok: true } : { ok: false, retryAfter: result.retryAfter };
};

/**
 * Gives back the one unit `chargeDailyLimit` took for a send that was then refused (the file window closed before its save).
 * A charge that took nothing (a platform admin, a tier without the kind) gives back nothing. `chargeKey` is the keyed send's
 * key, so its claim goes with the unit (`chat/daily-charge.ts#refundDailyCharge`).
 */
export const refundDailyLimit = async (
    context: Pick<HttpActionCtx, "runMutation">,
    user: LimitedUser & Pick<BetterAuthUser, "_id">,
    kind: DailyLimitKind,
    { chargeKey }: { chargeKey?: string } = {},
): Promise<void> => {
    if (isPlatformAdmin(user)) {
        return;
    }

    const key = dailyLimitKeyOf(kind, dailyLimitTierOf(user));

    if (!key) {
        return;
    }

    await context.runMutation(internal.chat.daily_charge.refundDailyCharge, {
        ...(chargeKey !== undefined && { chargeKey }),
        count: 1,
        identifier: user._id,
        key,
    });
};
