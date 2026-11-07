/**
 * The daily text quota a compaction's summarising call is charged to. The client's `/compact` and the automatic
 * compaction before a reply both charge it right before their first model call, so neither spends a model call the
 * other does not account for. A refusal throws; the automatic path catches it and the reply goes on uncompacted.
 */
import { LunoraError } from "lunorash/server";

import type { ActionCtx } from "../../_generated/server";
import { chargeDailyLimit } from "./daily-limit";

export const COMPACT_DAILY_LIMIT_MESSAGE = "You've reached your daily message limit. Compacting is available again tomorrow.";

/** `data.code` of the refusal the client words on its own, as `askAside` does. */
export const COMPACT_DAILY_LIMIT_CODE = "DAILY_MESSAGE_LIMIT_REACHED";

export const chargeCompactionCall = async (ctx: Pick<ActionCtx, "runMutation">, user: Parameters<typeof chargeDailyLimit>[1]): Promise<void> => {
    const charge = await chargeDailyLimit(ctx, user, "Text");

    if (!charge.ok) {
        throw new LunoraError("TOO_MANY_REQUESTS", COMPACT_DAILY_LIMIT_MESSAGE, {
            data: { code: COMPACT_DAILY_LIMIT_CODE, message: COMPACT_DAILY_LIMIT_MESSAGE, retryAfterMs: charge.retryAfter },
        });
    }
};
