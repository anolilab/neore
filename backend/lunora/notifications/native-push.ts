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
import { isUniqueViolation } from "../lib/error-helpers";
import { patchRow, withoutUndefined } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
import { isPhonePushConfigured } from "./native-push-config";
import { deleteIfUnchanged, trimPushDevices } from "./push-device-writes";

/** Expo push tokens: `ExponentPushToken[…]` (and the newer `ExpoPushToken[…]`). */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[\w-]+\]$/u;

const vExpoPushToken = v.string().check((value) => value.length <= 200 && EXPO_PUSH_TOKEN.test(value), { message: "Invalid push token" });

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** A BCP 47 language tag, as `Intl` reports the phone's (`de`, `pt-BR`, `zh-Hans-CN`). */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z\d]{1,8})*$/u;

const vLanguage = v.string().check((value) => value.length <= 35 && LANGUAGE_TAG.test(value), { message: "Invalid language" });

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
    .use(rateLimit("notifications/pushRegister"))
    .input({ buildsAlert: v.optional(v.boolean()), language: v.optional(vLanguage), platform: vPlatform, token: vExpoPushToken })
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
        // An expired session counts as gone: a phone tied to it would never be sent to. Checked before the write too, so
        // a request whose JWT outlived its session never takes a phone from a live registration.
        const isLive = async (row: { sessionId: string; userId: string }) => {
            const session = await database.session.findFirst({ consistency: "primary", where: { _id: row.sessionId as Id<"session"> } });

            return session?.userId === row.userId && session.expiresAt > Date.now();
        };

        if (!(await isLive({ sessionId, userId }))) {
            return refuse("session_ended");
        }

        // The row may be the account that signed in on this phone before. Reading and re-owning it needs the unguarded
        // database (RLS hides another user's row); every field written is the caller's own, nothing of the previous
        // owner's is read back or returned.
        // What this registration writes, whichever row it lands on. A phone that reports no language keeps none
        // (`undefined` removes the field in `patchRow`): the previous registration's may have been another person's.
        const phone = { buildsAlert: args.buildsAlert, language: args.language, platform: args.platform, sessionId, userId };
        const existing = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

        // A registration that started before the row's last one (a request held up on its way) is older news: it must not
        // overwrite a later sign-in's owner and session. The phone registers again on its next return to the front.
        if (existing && existing.lastSeenAt > now) {
            return refuse("superseded");
        }

        // The row as it was before this call took it over, if it existed: put back if the call is refused below, so a
        // refused registration never erases the one it replaced.
        let replaced = existing ?? undefined;

        if (existing) {
            await patchRow(database, "pushDevices", existing, { ...phone, lastSeenAt: now });
        } else {
            try {
                await ctx.db.insert("pushDevices", { ...withoutUndefined(phone), createdAt: now, lastSeenAt: now, token: args.token });
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

                replaced = raced;
                await patchRow(database, "pushDevices", raced, { ...phone, lastSeenAt: now });
            }
        }

        // A deletion that started between the check above and this write has already run its phone step (or will):
        // ask again, and take back this row, so a phone never outlives the account's erasure. A guest is deleted
        // without a deletion request (inactive-guest cleanup, the end of a merge), its sessions first: a session gone
        // by now means the same.
        const isSessionLive = await isLive({ sessionId, userId });
        const isDeleting = isSessionLive && (await isAccountDeletionUnderway(ctx, userId));

        if (!isSessionLive || isDeleting) {
            const written = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token, userId } });

            // Only the row exactly as this call wrote it: a newer registration since (another sign-in) stays.
            if (written?.sessionId === sessionId && written.lastSeenAt === now) {
                // The registration this call replaced goes back only while its sign-in is still live: one that signed out
                // meanwhile must not come back, and erasure revokes an account's sessions as its first step, so an
                // account being deleted fails this too (its deletion request lives on its own shard, unreadable here).
                // The caller's own row is never put back while the caller's account is the one going.
                const restorable = replaced !== undefined && (await isLive(replaced)) && !(replaced.userId === userId && isDeleting) ? replaced : undefined;

                if (restorable) {
                    const { buildsAlert, language, lastSeenAt, platform, sessionId: replacedSession, userId: replacedOwner } = restorable;

                    // Its language and build flag too (`undefined` removes the field): the refused call's must not stay behind.
                    await patchRow(database, "pushDevices", written, {
                        buildsAlert,
                        language,
                        lastSeenAt,
                        platform,
                        sessionId: replacedSession,
                        userId: replacedOwner,
                    });
                    // That account may have registered other phones meanwhile: keep it under the cap.
                    await trimPushDevices(database, replacedOwner);
                } else {
                    await deleteIfUnchanged(database, written);
                }
            }

            return refuse(isSessionLive ? "deleting" : "session_ended");
        }

        // Past the cap, the phones not seen for longest go.
        const pruned = await trimPushDevices(ctx.db, userId);

        ctx.log.event("notifications.register_push_device", {
            moved: replaced !== undefined && replaced.userId !== userId,
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
