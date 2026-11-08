/**
 * Phone push registration: the app's Expo push token, one `pushDevices` row
 * (global, keyed by token) owned by the account signed in on that phone.
 * Registering moves the row to the caller, so a second account signing in on the
 * same phone takes the phone over and the first stops getting pushes on it even if
 * its sign-out never reached the server. Each row records the session that
 * registered it.
 */
import { v } from "lunorash/server";

import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { systemDb } from "../lib/rls/scope";
import { isPhonePushConfigured } from "./native-push-config";
import { trimPushDevices } from "./push-device-writes";

/** Expo push tokens: `ExponentPushToken[…]` (and the newer `ExpoPushToken[…]`). */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[\w-]+\]$/u;

const vExpoPushToken = v.string().check((value) => value.length <= 200 && EXPO_PUSH_TOKEN.test(value), { message: "Invalid push token" });

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** Whether this deployment pushes to phones. The app asks for permission only when it does. */
export const getNativePushConfig = authQuery
    .input({})
    .output(v.object({ enabled: v.boolean() }))
    .query(async () => {
        return { enabled: isPhonePushConfigured(process.env) };
    });

/**
 * Registers this phone's Expo push token for the caller, tied to the caller's session: when that session ends or
 * expires without a sign-out on the phone, the phone gets nothing more.
 * A token another account holds moves to the caller: the latest registration of a phone wins, so a second account
 * signing in on it takes its pushes over even if the first one's sign-out never reached us. A push token is not a
 * secret, so whoever holds a leaked one can take a phone's pushes the same way, until the phone registers again;
 * nothing but the generic alert ever reaches a phone, and the move is logged (`moved`).
 * `registered: false` means phone push is off (no access token), the call carries no session, or the account is
 * being deleted.
 */
export const registerPushDevice = authMutation
    .use(rateLimit("notifications/push"))
    .input({ platform: vPlatform, token: vExpoPushToken })
    .output(v.object({ registered: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const refuse = (reason: "deleting" | "no_session" | "off") => {
            ctx.log.event("notifications.register_push_device", { platform: args.platform, refused: reason });

            return { registered: false };
        };

        if (!isPhonePushConfigured(process.env)) {
            return refuse("off");
        }

        const { userId } = ctx.user;
        const identity = await ctx.auth.getIdentity();
        const sessionId = identity?.sessionId;

        if (typeof sessionId !== "string") {
            return refuse("no_session");
        }

        // Behind the deletion workflow's push step, a new row would survive erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return refuse("deleting");
        }

        const now = Date.now();
        // The row may be the account that signed in on this phone before. Reading and re-owning it needs the unguarded
        // database (RLS hides another user's row); every field written is the caller's own, nothing of the previous
        // owner's is read back or returned.
        const database = systemDb(ctx);
        const existing = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });
        // The account the row was taken from, when it was another one: logged, so a takeover can be seen.
        let previousOwner = existing?.userId;

        if (existing) {
            await database.patch("pushDevices", existing._id, { lastSeenAt: now, platform: args.platform, sessionId, userId });
        } else {
            try {
                await ctx.db.insert("pushDevices", { createdAt: now, lastSeenAt: now, platform: args.platform, sessionId, token: args.token, userId });
            } catch (error) {
                // Another registration of this phone inserted between the read and the write (`by_token` is unique):
                // take its row over instead, so the phone still has exactly one owner, the latest to register.
                const raced = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

                if (!raced) {
                    throw error;
                }

                previousOwner = raced.userId;
                await database.patch("pushDevices", raced._id, { lastSeenAt: now, platform: args.platform, sessionId, userId });
            }
        }

        // A deletion that started between the check above and this write has already run its phone step (or will):
        // ask again, and take back this row, so a phone never outlives the account's erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            const written = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token, userId } });

            if (written) {
                await database.delete("pushDevices", written._id);
            }

            return refuse("deleting");
        }

        // Past the cap, the phones not seen for longest go.
        const pruned = await trimPushDevices(ctx.db, userId);

        ctx.log.event("notifications.register_push_device", {
            moved: previousOwner !== undefined && previousOwner !== userId,
            platform: args.platform,
            pruned,
        });

        return { registered: true };
    });

/**
 * Sign-out: this phone stops getting the caller's pushes. Only the row this sign-in registered goes: another account's
 * row for the token, or one the same account registered again under a newer sign-in before this release was read, is
 * left alone.
 */
export const unregisterPushDevice = authMutation
    .use(rateLimit("notifications/pushRelease"))
    .input({ token: v.string().check((value) => value.length > 0 && value.length <= 200, { message: "Invalid push token" }) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const identity = await ctx.auth.getIdentity();
        const sessionId = identity?.sessionId;
        const row =
            typeof sessionId === "string"
                ? await ctx.db.pushDevices.findFirst({ consistency: "primary", where: { sessionId, token: args.token, userId: ctx.user.userId } })
                : undefined;

        if (row) {
            await ctx.db.delete("pushDevices", row._id);
        }

        ctx.log.event("notifications.unregister_push_device", { removed: Boolean(row) });

        return null;
    });
