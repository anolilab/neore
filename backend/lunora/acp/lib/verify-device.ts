/** The one check that a signed request is from a live device, shared by every route a paired computer posts to. */
import type { QueryCtx } from "../../_generated/server";
import { DEVICE_SIGNATURE_WINDOW_MS } from "../../devices/lib/constants";
import type { DeviceSigningDomain } from "../../devices/lib/signing";
import { isFreshTimestamp, parseSignedPayload, verifyDevicePayload } from "../../devices/lib/signing";
import { decryptKey } from "../../lib/encryption";

/** What a verified request proved: whose device it is, and the payload's fields. */
export interface VerifiedDeviceRequest {
    post: Record<string, unknown>;
    userId: string;
}

/**
 * Who owns the device whose signed `payload` this is, or null: unknown or revoked device, a signature under another
 * domain or secret, a payload that does not name this device, a stale `issuedAt`. Every refusal looks the same.
 */
export const verifyDeviceRequest = async (
    ctx: Pick<QueryCtx, "db">,
    args: { deviceId: string; domain: DeviceSigningDomain; now: number; payload: string; signature: string },
): Promise<VerifiedDeviceRequest | null> => {
    const deviceId = ctx.db.normalizeId("devices", args.deviceId);
    const device = deviceId ? await ctx.db.devices.findFirst({ where: { _id: deviceId } }) : null;

    if (!device?.encryptedSecret) {
        return null;
    }

    const secret = await decryptKey(device.encryptedSecret, "device-secrets");

    if (!(await verifyDevicePayload(secret, args.domain, args.payload, args.signature))) {
        return null;
    }

    const post = parseSignedPayload(args.payload, args.domain, device._id as string);

    return post && isFreshTimestamp(post.issuedAt, args.now, DEVICE_SIGNATURE_WINDOW_MS) ? { post, userId: device.userId } : null;
};
