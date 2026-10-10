/**
 * Device and call state shared by the procedures (`functions.ts`) and the
 * internal side (`internal.ts`).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { DEVICE_ONLINE_WINDOW_MS } from "./constants";

export const isDeviceOnline = (device: Pick<Doc<"devices">, "lastSeenAt">, now: number): boolean =>
    device.lastSeenAt !== undefined && now - device.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS;

export const OPEN_CALL_STATUSES = ["pending", "claimed"] as const;

export const isTerminalCallStatus = (status: Doc<"deviceCalls">["status"]): boolean => status !== "pending" && status !== "claimed";

const PHASE_RANK = { prompting: 1, running: 2 } as const;

/** Progress reports only move a call forward: none → prompting → running (a rule skips the prompt). */
export const isForwardPhase = (current: Doc<"deviceCalls">["phase"], next: NonNullable<Doc<"deviceCalls">["phase"]>): boolean =>
    PHASE_RANK[next] > (current === undefined ? 0 : PHASE_RANK[current]);

/** Expires every open call of a device (revoke). */
export const expireOpenCalls = async (ctx: Pick<MutationCtx, "db">, deviceId: Id<"devices">, reason: string): Promise<void> => {
    const now = Date.now();

    for (const status of OPEN_CALL_STATUSES) {
        const { page } = await ctx.db.deviceCalls.findMany({ limit: 50, where: { deviceId, status } });

        await Promise.all(page.map(async (call) => await ctx.db.patch(call._id, { completedAt: now, error: reason, status: "expired" })));
    }
};
