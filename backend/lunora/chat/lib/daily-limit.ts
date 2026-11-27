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
import { callOnShard } from "../../lib/cross-shard";
import { chatLogger } from "../../lib/logger";
import { getUserTier, type RateLimitKey } from "../../lib/rate-limiter";
import { currentShard } from "../../lib/shard-context";

export type DailyLimitKind = "Audio" | "Image" | "Suggestion" | "Text" | "Video";

export type DailyLimitTier = "anonymous" | "free" | "premium";

/**
 * The config each kind is charged to, per tier. An absent entry is a tier that
 * may not generate that kind at all (guests and video), and is refused.
 */
const DAILY_LIMIT_KEYS: Record<DailyLimitKind, Partial<Record<DailyLimitTier, RateLimitKey>>> = {
    Audio: { anonymous: "chat/dailyAudio:anonymous", free: "chat/dailyAudio:free", premium: "chat/dailyAudio:premium" },
    Image: { anonymous: "chat/dailyImage:anonymous", free: "chat/dailyImage:free", premium: "chat/dailyImage:premium" },
    // Follow-up suggestions have their own bucket, so one never takes a unit a real send needs. Guests get none (no entry).
    Suggestion: { free: "chat/dailySuggestion:free", premium: "chat/dailySuggestion:premium" },
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

/** `windowStart` is the fixed window the units were taken from; a refund gives them back only while that window is current. */
export type DailyLimitResult = { ok: true; windowStart?: number } | { ok: false; retryAfter?: number };

type LimitArgs = { count: number; identifier: string; key: string };

/**
 * Whether a daily-quota call for `userId` may run where the code is now. A user's quota lives on the user's own shard, not on
 * the shard the work runs on: a shared thread's work runs on its owner's shard (and so does `/chat/media`), so a charge made
 * there would draw on a second counter for the same person. Routes that act for a user enter that user's shard
 * (`lib/http-shard.ts`), so a context on another shard crosses to the user's. No shard context at all stays where it is.
 */
export const onUserShard = (userId: string): boolean => {
    const shard = currentShard();

    return shard === undefined || shard === userId;
};

const applyOnHomeShard = async (context: Pick<HttpActionCtx, "runMutation">, userId: string, args: LimitArgs) => {
    if (onUserShard(userId)) {
        return await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, args);
    }

    return await callOnShard(internal.lib.rate_limiter_mutations.applyRateLimit, args, { shardKey: userId });
};

const chargeOnceOnHomeShard = async (context: Pick<HttpActionCtx, "runMutation">, userId: string, args: LimitArgs & { chargeKey: string }) => {
    if (onUserShard(userId)) {
        return await context.runMutation(internal.chat.daily_charge.chargeDailyLimitOnce, args);
    }

    return await callOnShard(internal.chat.daily_charge.chargeDailyLimitOnce, args, { shardKey: userId });
};

const refundOnHomeShard = async (
    context: Pick<HttpActionCtx, "runMutation">,
    userId: string,
    args: { chargeKey?: string; count: number; identifier: string; key: string; windowStart?: number },
) => {
    if (onUserShard(userId)) {
        return await context.runMutation(internal.chat.daily_charge.refundDailyCharge, args);
    }

    return await callOnShard(internal.chat.daily_charge.refundDailyCharge, args, { shardKey: userId });
};

/**
 * Charge `count` units of `kind` to `user`'s daily quota, on the user's own shard. With a `chargeKey` (a keyed send's, `startChargeKey`)
 * the units are taken once per key (`chat/daily-charge.ts#chargeDailyLimitOnce`): a retry of a send already charged is not charged again.
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
            ? await applyOnHomeShard(context, user._id, { count, identifier: user._id, key })
            : await chargeOnceOnHomeShard(context, user._id, { chargeKey, count, identifier: user._id, key });

    if (!result.ok) {
        return { ok: false, retryAfter: result.retryAfter };
    }

    return { ok: true, ...(result.windowStart !== undefined && { windowStart: result.windowStart }) };
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
    { chargeKey, windowStart }: { chargeKey?: string; windowStart?: number } = {},
): Promise<void> => {
    if (isPlatformAdmin(user)) {
        return;
    }

    const key = dailyLimitKeyOf(kind, dailyLimitTierOf(user));

    if (!key) {
        return;
    }

    // Best effort: the refusal it follows is the answer the client gets, so a failed refund must not replace it with a 500.
    try {
        await refundOnHomeShard(context, user._id, {
            ...(chargeKey !== undefined && { chargeKey }),
            count: 1,
            identifier: user._id,
            key,
            ...(windowStart !== undefined && { windowStart }),
        });
    } catch (error) {
        chatLogger.error("Could not refund a daily quota unit:", error);
    }
};
