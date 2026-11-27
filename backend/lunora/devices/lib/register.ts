/**
 * Creating a device row: the one place a device secret is generated and stored. `registerDevice` (a desktop, or a
 * server a desktop holds) and `registerHeadlessDevice` (a machine that paired itself by code) both end here.
 */
import { LunoraError } from "lunorash/server";

import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { encryptKey } from "../../lib/encryption";
import { notify, notifyQuietly } from "../../notifications/notify";
import { setShardRoute } from "../../lib/shard-routes";
import { DEVICE_LIMIT_CODE, MAX_DEVICES_PER_USER } from "./constants";
import { generateDeviceSecret } from "./signing";

type NewDevice = Partial<Pick<Doc<"devices">, "alertPending" | "pairedByCode" | "projectIds" | "transport" | "viaDeviceId">> &
    Pick<Doc<"devices">, "name" | "platform" | "userId">;

/** Refuses when the account already holds as many devices as it may. */
export const assertRoomForDevice = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<void> => {
    const { page } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER + 1, where: { userId } });

    if (page.length >= MAX_DEVICES_PER_USER) {
        throw new LunoraError("BAD_REQUEST", `At most ${String(MAX_DEVICES_PER_USER)} devices can be paired. Remove one first.`, {
            data: { code: DEVICE_LIMIT_CODE },
        });
    }
};

/** Inserts the row with a fresh encrypted secret and the host-ingest route. Returns the plaintext secret ONCE. */
export const insertDevice = async (ctx: Pick<MutationCtx, "db" | "now">, device: NewDevice): Promise<{ deviceId: string; secret: string }> => {
    const secret = generateDeviceSecret();
    const deviceId = await ctx.db.insert("devices", {
        createdAt: ctx.now,
        encryptedSecret: await encryptKey(secret, "device-secrets"),
        name: device.name,
        platform: device.platform,
        userId: device.userId,
        ...(device.pairedByCode !== undefined && { pairedByCode: device.pairedByCode }),
        ...(device.transport !== undefined && { transport: device.transport }),
        ...(device.projectIds !== undefined && { projectIds: device.projectIds }),
        ...(device.viaDeviceId !== undefined && { viaDeviceId: device.viaDeviceId }),
        ...(device.alertPending === true && { alertPending: true }),
    });

    // The host ingest has no session: it finds this device's owner, hence its shard, from this row.
    await setShardRoute(ctx, "device", deviceId as string, device.userId);

    return { deviceId: deviceId as string, secret };
};

/**
 * Writes the owner's alert for a device that was just paired, once. `alertPending` is set when the row is created and
 * cleared here, in the same transaction as the alert, so a repeat call or the housekeeping sweep finds nothing left to do.
 * The registration never calls this: the callers that do run after the secret is returned, so a failure to hand the alert
 * off cannot cost the caller the device. It uses `notify`, not `notifyQuietly`: a failed alert write must roll the cleared flag
 * back with it, or nothing would ever retry the alert. `quiet` is for a caller that must not fail on the alert (a revoke removes
 * the device, so there is nothing left to retry): the flag is cleared and a failed write is dropped.
 */
export const announceNewDevice = async (ctx: MutationCtx, device: Doc<"devices">, options: { quiet?: boolean } = {}): Promise<void> => {
    if (device.alertPending !== true) {
        return;
    }

    await ctx.db.patch("devices", device._id, { alertPending: false });

    const send = options.quiet ? notifyQuietly : notify;

    await send(ctx, {
        dedupeKey: `device-paired:${device._id as string}`,
        link: "/dashboard/settings/chat/devices",
        title: device.name,
        type: "device_paired",
        userId: device.userId,
    });
};
