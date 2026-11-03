/**
 * Creating a device row: the one place a device secret is generated and stored. `registerDevice` (a desktop, or a
 * server a desktop holds) and `registerHeadlessDevice` (a machine that paired itself by code) both end here.
 */
import { LunoraError } from "lunorash/server";

import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { encryptKey } from "../../lib/encryption";
import { setShardRoute } from "../../lib/shard-routes";
import { MAX_DEVICES_PER_USER } from "./constants";
import { generateDeviceSecret } from "./signing";

type NewDevice = Partial<Pick<Doc<"devices">, "transport" | "viaDeviceId">> & Pick<Doc<"devices">, "name" | "platform" | "userId">;

/** Refuses when the account already holds as many devices as it may. */
export const assertRoomForDevice = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<void> => {
    const { page } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER + 1, where: { userId } });

    if (page.length >= MAX_DEVICES_PER_USER) {
        throw new LunoraError("BAD_REQUEST", `At most ${String(MAX_DEVICES_PER_USER)} devices can be paired. Remove one first.`);
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
        ...(device.transport !== undefined && { transport: device.transport }),
        ...(device.viaDeviceId !== undefined && { viaDeviceId: device.viaDeviceId }),
    });

    // The host ingest has no session: it finds this device's owner, hence its shard, from this row.
    await setShardRoute(ctx, "device", deviceId as string, device.userId);

    return { deviceId: deviceId as string, secret };
};
