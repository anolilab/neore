/**
 * The four-hour approval reminder's sweep, run on the owner's shard at the moment a pause comes due. The writer of a pause
 * schedules it (`tool-permissions.ts`), so an idle shard is not left to the per-user housekeeping, which can wait a day and miss
 * the window (`lib/approval-reminder.ts`).
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { remindPendingApprovals } from "./lib/approval-reminder";

export const sweepApprovalReminders = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ ctx }) => {
        await remindPendingApprovals(ctx, ctx.now);

        return null;
    });
