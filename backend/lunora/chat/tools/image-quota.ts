/**
 * The daily image bucket every image call from a chat tool draws on: generation (`image-generation.ts`), editing
 * (`image-editing.ts`) and the canvas tool's edits and element generation (`canvas-ai.ts`).
 *
 * It is the bucket `/chat/media` charges (`chargeDailyLimit`, kind "Image"), so a tool call and a media request count
 * against one allowance, with the same tiers (`DAILY_LIMIT_KEYS` in `chat/lib/daily-limit.ts`). The tier comes from the
 * user's row and the run's plan, read here on the server; a tool context carries no tier of its own.
 *
 * Taken before the provider call. A spent allowance is refused with `DAILY_IMAGE_LIMIT_REACHED`, and a failed check with
 * `IMAGE_QUOTA_UNAVAILABLE` (fail closed). A unit is not given back when the provider later fails, as with `/chat/media`.
 */
import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { readRunPlan } from "../lib/agent-run";
import { chargeDailyLimit } from "../lib/daily-limit";

export const DAILY_IMAGE_LIMIT_REACHED = "DAILY_IMAGE_LIMIT_REACHED";
export const IMAGE_QUOTA_UNAVAILABLE = "IMAGE_QUOTA_UNAVAILABLE";

export type ImageQuotaCode = typeof DAILY_IMAGE_LIMIT_REACHED | typeof IMAGE_QUOTA_UNAVAILABLE;

export type ImageQuotaResult = { ok: true } | { code: ImageQuotaCode; message: string; ok: false; retryAfter?: number };

/**
 * Charges `count` images to `userId`'s daily image allowance. Call it after the request is validated and before the provider
 * call, so a refused request costs nothing.
 */
export const takeImageQuota = async (context: ToolContext, userId: string, count: number): Promise<ImageQuotaResult> => {
    try {
        const [flags, plan] = await Promise.all([
            context.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId }),
            readRunPlan(context, userId, context.organizationId),
        ]);
        const charge = await chargeDailyLimit(
            context,
            { _id: userId, isAnonymous: flags.isAnonymous, plan: plan.plan, role: plan.isAdmin ? "admin" : flags.role },
            "Image",
            count,
        );

        if (charge.ok) {
            return { ok: true };
        }

        return {
            code: DAILY_IMAGE_LIMIT_REACHED,
            message: `${DAILY_IMAGE_LIMIT_REACHED}: the daily image limit is reached. Generated and edited images share it; try again after it resets.`,
            ok: false,
            retryAfter: charge.retryAfter,
        };
    } catch (error) {
        toolsLogger.error(`[IMAGE_QUOTA] Could not check the daily image limit: ${error instanceof Error ? error.message : String(error)}`);

        return {
            code: IMAGE_QUOTA_UNAVAILABLE,
            message: `${IMAGE_QUOTA_UNAVAILABLE}: the daily image limit could not be checked, so no image was made. Try again shortly.`,
            ok: false,
        };
    }
};
