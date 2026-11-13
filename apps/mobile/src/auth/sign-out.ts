import { StoredGrantNotClearedError } from "./stored-grant-error";

/** How long sign-out waits for the server to drop this phone's push token before it carries on without it. */
export const RELEASE_PUSH_TIMEOUT_MS = 5000;

interface SignOutSteps {
    /** Empties the offline cache. */
    clearCache: () => Promise<void>;
    /** Removes the alerts still on the phone. */
    dismissNotifications?: () => Promise<void>;
    /** Removes the alerts once more and forgets the account. Called only once its session is revoked: a push sent before the revoke can still arrive. */
    forgetAccount?: () => Promise<void>;
    /** Forgets the chat saved to reopen on launch. */
    forgetLastChat: () => Promise<void>;
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
    try {
        await dismiss?.();
    } catch (error) {
        warn("Could not remove this account's notifications.", error);
    }
};

/** Revokes the stored session. True only when the revoke landed; offline or refused, the session expires on its own, and nothing on the phone holds it. */
const revokeIfStored = async (token: string | undefined, revokeSession: (token: string) => Promise<void>, warn: (message: string, error: unknown) => void): Promise<boolean> => {
    if (token === undefined) {
        return false;
    }

    try {
        await revokeSession(token);

        return true;
    } catch (error) {
        warn("Could not revoke the session on the server.", error);

        return false;
    }
};

/** Forgets the account on the phone once its session is revoked. A failed revoke keeps the record, so the next sign-in sees the switch. */
const forgetRevokedAccount = async (isRevoked: boolean, forget: (() => Promise<void>) | undefined, warn: (message: string, error: unknown) => void): Promise<void> => {
    if (!isRevoked) {
        return;
    }

    try {
        await forget?.();
    } catch (error) {
        warn("Could not forget the account on this phone.", error);
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
export const signOutOnDevice = async ({
    clearCache,
    dismissNotifications,
    forgetAccount,
    forgetLastChat,
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

    const isRevoked = await revokeIfStored(token, revokeSession, warn);

    await forgetRevokedAccount(isRevoked, forgetAccount, warn);
};

/**
 * Runs whenever the app finds nobody signed in (at launch, or when a refresh finds no grant or the server rejects it):
 * empties the offline cache and forgets the saved chat again, so a wipe that failed at sign-out (a locked or full disk),
 * or a session that ended without one, cannot leave the last account's chats on the device until someone signs in.
 * A session the server ended never ran the sign-out, so the alerts of the account it held are removed here too.
 * Never blocks: a failure only warns, and the next signed-out start tries again.
 */
export const emptyCacheWhileSignedOut = async ({
    clearCache,
    dismissNotifications,
    forgetLastChat,
    warn,
}: Pick<SignOutSteps, "clearCache" | "dismissNotifications" | "forgetLastChat" | "warn">): Promise<void> => {
    // The forget is queued at once, not after the cache wipe: the sign-in screen is already up, and a chat saved by a
    // quick sign-in must queue after this forget, or the forget would delete it.
    const [cache, lastChat, alerts] = await Promise.allSettled([clearCache(), forgetLastChat(), dismissNotifications?.()]);

    if (cache.status === "rejected") {
        warn("Could not empty the offline cache.", cache.reason);
    }

    if (lastChat.status === "rejected") {
        warn("Could not forget the last viewed chat.", lastChat.reason);
    }

    if (alerts.status === "rejected") {
        warn("Could not remove this account's notifications.", alerts.reason);
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
