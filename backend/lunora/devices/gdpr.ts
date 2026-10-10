/**
 * Paired devices and their call audit in the GDPR export and account deletion.
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-devices") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-devices"). Deletion
 * follows the residual steps' contract: at most `BATCH` rows per table per
 * call, `{ hasMore }` back, idempotent on retry.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_DEVICES_PER_USER } from "./lib/constants";

const BATCH = 200;

/** Calls are pruned after 30 days (`sweepDeviceCalls`); this bounds the read anyway. */
const EXPORT_CALLS_MAX = 5000;

export const collectDevicesForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ calls: v.array(v.any()), devices: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const [devices, calls] = await Promise.all([
            ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER, where: { userId } }),
            ctx.db.deviceCalls.findMany({ limit: EXPORT_CALLS_MAX, orderBy: [{ createdAt: "desc" }], where: { userId } }),
        ]);

        return {
            // The secret is a credential for that install, not data about the user.
            calls: calls.page.map(({ completedAt, createdAt, decision, deviceName, error, exitCode, input, output, status, taintedBy, threadId, toolName }) => {
                return { completedAt, createdAt, decision, deviceName, error, exitCode, input, output, status, taintedBy, threadId, toolName };
            }),
            devices: devices.page.map(({ createdAt, lastSeenAt, manifest, name, platform }) => {
                return { createdAt, lastSeenAt, name, platform, tools: (manifest ?? []).map((tool) => tool.name) };
            }),
        };
    });

export const deleteUserDevices = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const [devices, calls] = await Promise.all([
            ctx.db.devices.findMany({ limit: BATCH, where: { userId } }),
            ctx.db.deviceCalls.findMany({ limit: BATCH, where: { userId } }),
        ]);

        await Promise.all([...devices.page, ...calls.page].map(async (row) => await ctx.db.delete(row._id)));

        return { hasMore: devices.page.length >= BATCH || calls.page.length >= BATCH };
    });
