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
import type { Id } from "../_generated/dataModel";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { systemDb } from "../lib/rls/scope";
import { isPhonePushConfigured } from "./native-push-config";
import { deleteIfUnchanged, trimPushDevices } from "./push-device-writes";

/** Expo push tokens: `ExponentPushToken[…]` (and the newer `ExpoPushToken[…]`). */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[\w-]+\]$/u;

const vExpoPushToken = v.string().check((value) => value.length <= 200 && EXPO_PUSH_TOKEN.test(value), { message: "Invalid push token" });

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** SQLite's own wording for a unique index refusing a row, as Lunora's D1 layer reports it; nothing else is a race. */
const UNIQUE_CONSTRAINT_FAILED = /unique constraint failed/iu;

const isUniqueViolation = (error: unknown): boolean => {
    const cause = error instanceof Error ? error.cause : undefined;

    return UNIQUE_CONSTRAINT_FAILED.test(String(error)) || (cause !== undefined && UNIQUE_CONSTRAINT_FAILED.test(String(cause)));
};

/**
 * The sign-in a call comes from: the phone app's grant (`grantSessionId`, from its JWT's `gsid`) or a web session
 * (`sessionId`). The grant's is never handed out as `sessionId` (`src/bearer-identity.ts`), so it is read here by name.
 */
const callerSignIn = (identity: Record<string, unknown> | null | undefined): string | undefined => {
    const signIn = identity?.grantSessionId ?? identity?.sessionId;

    return typeof signIn === "string" ? signIn : undefined;
};

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
 * `registered: false` means phone push is off (no access token), the call carries no session, the account is being
 * deleted, or the request was superseded (it started before the row's last registration; the phone retries).
 */
export const registerPushDevice = authMutation
    .use(rateLimit("notifications/push"))
    .input({ platform: vPlatform, token: vExpoPushToken })
    .output(v.object({ registered: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const refuse = (reason: "deleting" | "no_session" | "off" | "session_ended" | "superseded") => {
            ctx.log.event("notifications.register_push_device", { platform: args.platform, refused: reason });

            return { registered: false };
        };

        if (!isPhonePushConfigured(process.env)) {
            return refuse("off");
        }

        const { userId } = ctx.user;
        const sessionId = callerSignIn(await ctx.auth.getIdentity());

        if (sessionId === undefined) {
            return refuse("no_session");
        }

        // Behind the deletion workflow's push step, a new row would survive erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return refuse("deleting");
        }

        const now = Date.now();
        const database = systemDb(ctx);
        const isLive = async () => {
            // An expired session counts as gone: a phone tied to it would never be sent to. Checked before the write too,
            // so a request whose JWT outlived its session never takes a phone from a live registration.
            const session = await database.session.findFirst({ consistency: "primary", where: { _id: sessionId as Id<"session"> } });

            return session?.userId === userId && session.expiresAt > Date.now();
        };

        if (!(await isLive())) {
            return refuse("session_ended");
        }

        // The row may be the account that signed in on this phone before. Reading and re-owning it needs the unguarded
        // database (RLS hides another user's row); every field written is the caller's own, nothing of the previous
        // owner's is read back or returned.
        const existing = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

        // A registration that started before the row's last one (a request held up on its way) is older news: it must not
        // overwrite a later sign-in's owner and session. The phone registers again on its next return to the front.
        if (existing && existing.lastSeenAt > now) {
            return refuse("superseded");
        }

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
                if (!isUniqueViolation(error)) {
                    throw error;
                }

                const raced = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

                if (!raced) {
                    throw error;
                }

                if (raced.lastSeenAt > now) {
                    return refuse("superseded");
                }

                previousOwner = raced.userId;
                await database.patch("pushDevices", raced._id, { lastSeenAt: now, platform: args.platform, sessionId, userId });
            }
        }

        // A deletion that started between the check above and this write has already run its phone step (or will):
        // ask again, and take back this row, so a phone never outlives the account's erasure. A guest is deleted
        // without a deletion request (inactive-guest cleanup, the end of a merge), its sessions first: a session gone
        // by now means the same.
        const isSessionLive = await isLive();
        const isDeleting = isSessionLive && (await isAccountDeletionUnderway(ctx, userId));

        if (!isSessionLive || isDeleting) {
            const written = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token, userId } });

            if (written) {
                await deleteIfUnchanged(database, written);
            }

            return refuse(isSessionLive ? "deleting" : "session_ended");
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
        const sessionId = callerSignIn(await ctx.auth.getIdentity());
        const row =
            sessionId === undefined
                ? undefined
                : await ctx.db.pushDevices.findFirst({ consistency: "primary", where: { sessionId, token: args.token, userId: ctx.user.userId } });

        // Skipped when the phone registered again (or moved to another account) since the read above.
        const isRemoved = row ? await deleteIfUnchanged(ctx.db, row) : false;

        ctx.log.event("notifications.unregister_push_device", { removed: isRemoved });

        return null;
    });
