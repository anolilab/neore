import type { StoredGrant } from "./grant";
import { StoredGrantNotClearedError } from "./stored-grant-error";

/** How long sign-out waits for the server to drop this phone's push token before it carries on without it. */
export const RELEASE_PUSH_TIMEOUT_MS = 5000;

/** How long sign-out waits for the phone's alerts to be removed before it carries on without them. */
export const ALERT_REMOVAL_TIMEOUT_MS = 5000;

interface SignOutSteps {
    /** Empties the offline cache. */
    clearCache: () => Promise<void>;
    /** Removes the alerts still on the phone. */
    dismissNotifications?: () => Promise<void>;
    /** Forgets the chat saved to reopen on launch. */
    forgetLastChat: () => Promise<void>;
    /** Records the token of the grant being signed out, so a background task refuses it even if the stored session stays readable. */
    markSignedOut?: (token: string) => Promise<void>;
    /** Tells the server this phone stops getting the account's pushes. Signs in with the in-memory JWT. */
    releasePush?: () => Promise<void>;
    /** Revokes the session server-side. May fail, or never answer, with no network. */
    revokeSession: (token: string) => Promise<void>;
    /** Clears the stored session and resolves its token, or `undefined`. Runs before anything waits on the network. */
    takeCredential: () => Promise<string | undefined>;
    warn: (message: string, error: unknown) => void;
}

/** Removes the alerts of the account that leaves. A failure only warns: sign-out goes on, and the next sign-in sees the switch. */
const removeAlerts = async (dismiss: (() => Promise<void>) | undefined, warn: (message: string, error: unknown) => void): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            dismiss?.(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Timed out")), ALERT_REMOVAL_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        warn("Could not remove this account's notifications.", error);
    } finally {
        clearTimeout(timer);
    }
};

/** Revokes the stored session. Offline or refused, the session expires on its own, and nothing on the phone holds it. */
const revokeStored = async (token: string | undefined, revokeSession: (token: string) => Promise<void>, warn: (message: string, error: unknown) => void): Promise<void> => {
    if (token === undefined) {
        return;
    }

    try {
        await revokeSession(token);
    } catch (error) {
        warn("Could not revoke the session on the server.", error);
    }
};

/**
 * Signing out takes the person's saved chats off the device FIRST, locally, before the server is asked anything: a
 * sign-out request that fails or hangs offline must not leave their chats behind for the next person to open.
 *
 * Then the stored session is cleared, still locally, so nothing on the phone can sign in as them from here on. Then the
 * phone's push token is released while the in-memory sign-in still works, waited on for at most
 * {@link RELEASE_PUSH_TIMEOUT_MS}. Last the session is revoked server-side with the token taken above.
 */
/** Whether `markedToken` is the token a sign-out recorded for `grant`: a grant left readable by a failed clear is refused. */
export const wasSignedOut = (grant: StoredGrant, markedToken: string | null): boolean => markedToken === grant.token;

export const signOutOnDevice = async ({
    clearCache,
    dismissNotifications,
    forgetLastChat,
    markSignedOut,
    releasePush,
    revokeSession,
    takeCredential,
    warn,
}: SignOutSteps): Promise<void> => {
    try {
        await clearCache();
    } catch (error) {
        warn("Could not empty the offline cache.", error);
    }

    try {
        await forgetLastChat();
    } catch (error) {
        warn("Could not forget the last viewed chat.", error);
    }

    let token: string | undefined;

    try {
        token = await takeCredential();
    } catch (error) {
        // The stored session could not be cleared. The user is still signed out in memory by the caller, and the session
        // is still revoked below with the token the failed clear carries, so a grant left behind stops working. The
        // warning gets only the keychain failure: the error itself carries the session token.
        token = error instanceof StoredGrantNotClearedError ? error.token : undefined;
        warn("Could not clear the stored sign-in.", error instanceof StoredGrantNotClearedError ? error.cause : error);
    }

    if (token !== undefined && markSignedOut) {
        try {
            await markSignedOut(token);
        } catch (error) {
            warn("Could not record the sign-out for the background task.", error);
        }
    }

    await removeAlerts(dismissNotifications, warn);

    if (releasePush) {
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            await Promise.race([
                releasePush(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Timed out")), RELEASE_PUSH_TIMEOUT_MS);
                }),
            ]);
        } catch (error) {
            warn("Could not stop notifications for this phone.", error);
        } finally {
            clearTimeout(timer);
        }
    }

    await revokeStored(token, revokeSession, warn);

    // Once more after the revoke, whether or not it landed: a push accepted before the revoke can still be on its way.
    await removeAlerts(dismissNotifications, warn);
};

/**
 * Runs whenever the app finds nobody signed in (at launch, or when a refresh finds no grant or the server rejects it):
 * empties the offline cache and forgets the saved chat again, so a wipe that failed at sign-out (a locked or full disk),
 * or a session that ended without one, cannot leave the last account's chats on the device until someone signs in.
 * Never blocks: a failure only warns, and the next signed-out start tries again.
 */
export const emptyCacheWhileSignedOut = async ({ clearCache, forgetLastChat, warn }: Pick<SignOutSteps, "clearCache" | "forgetLastChat" | "warn">): Promise<void> => {
    // The forget is queued at once, not after the cache wipe: the sign-in screen is already up, and a chat saved by a
    // quick sign-in must queue after this forget, or the forget would delete it.
    const [cache, lastChat] = await Promise.allSettled([clearCache(), forgetLastChat()]);

    if (cache.status === "rejected") {
        warn("Could not empty the offline cache.", cache.reason);
    }

    if (lastChat.status === "rejected") {
        warn("Could not forget the last viewed chat.", lastChat.reason);
    }
};

/**
 * The order of a sign-out: every token mint still out is ended (`endMints`, the auth epoch) BEFORE the first await of the
 * teardown, so one answering while the cache is emptied or the grant revoked applies nothing; then the teardown; then,
 * whatever it did, the mints are ended again (one started during the teardown) and the session is finished.
 */
export const runSignOut = async ({ endMints, finish, teardown }: { endMints: () => void; finish: () => void; teardown: () => Promise<void> }): Promise<void> => {
    endMints();

    try {
        await teardown();
    } finally {
        endMints();
        finish();
    }
};
