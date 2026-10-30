/**
 * Device and call state shared by the procedures (`functions.ts`) and the
 * internal side (`internal.ts`).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { ACP_CLAIM_WINDOW_MS, ACP_TOOLS, DEVICE_CLAIM_WINDOW_MS, DEVICE_ONLINE_WINDOW_MS } from "./constants";

export const isDeviceOnline = (device: Pick<Doc<"devices">, "lastSeenAt">, now: number): boolean =>
    device.lastSeenAt !== undefined && now - device.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS;

const ACP_TOOL_NAMES: ReadonlySet<string> = new Set(ACP_TOOLS);

/** A coding-agent call (`acp_start`, `acp_send`, `acp_cancel`, `acp_permission_answer`), not a device tool. */
export const isAcpTool = (toolName: string): boolean => ACP_TOOL_NAMES.has(toolName);

/** How long a call may wait for its device to claim it. */
export const claimWindowMs = (toolName: string): number => (isAcpTool(toolName) ? ACP_CLAIM_WINDOW_MS : DEVICE_CLAIM_WINDOW_MS);

export const OPEN_CALL_STATUSES = ["pending", "claimed"] as const;

/** Open calls read per page by {@link countOpenCalls}. */
export const OPEN_CALL_PAGE = 50;

/**
 * How many of a device's open (`pending` or `claimed`) calls satisfy `counts`, stopping once `stopAt` is reached.
 * Read page by page and filtered after: a fixed-size first page would let a pile of one kind of call (coding-agent
 * calls that expired unclaimed) push the other kind out of the count.
 */
export const countOpenCalls = async (
    ctx: Pick<MutationCtx, "db">,
    deviceId: Id<"devices">,
    counts: (call: Doc<"deviceCalls">) => boolean,
    stopAt: number,
): Promise<number> => {
    let open = 0;

    for (const status of OPEN_CALL_STATUSES) {
        let cursor: string | undefined;

        do {
            const page = await ctx.db.deviceCalls.findMany({ cursor, limit: OPEN_CALL_PAGE, where: { deviceId, status } });

            open += page.page.filter((call) => counts(call)).length;

            if (open >= stopAt) {
                return open;
            }

            cursor = page.isDone ? undefined : (page.continueCursor ?? undefined);
        } while (cursor);
    }

    return open;
};

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
