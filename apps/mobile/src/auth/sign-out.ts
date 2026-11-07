/** The session token a failed credential clear carries (`StoredGrantNotClearedError`), if any. */
const tokenOf = (error: unknown): string | undefined => {
    const { token } = (error ?? {}) as { token?: unknown };

    return typeof token === "string" ? token : undefined;
};

/** How long sign-out waits for the server to drop this phone's push token before it carries on without it. */
export const RELEASE_PUSH_TIMEOUT_MS = 5000;

interface SignOutSteps {
    /** Empties the offline cache. */
    clearCache: () => Promise<void>;
    /** Removes this account's notifications already on the phone, so the next person does not see them. */
    dismissNotifications?: () => Promise<void>;
    /** Forgets the chat saved to reopen on launch. */
    forgetLastChat: () => Promise<void>;
    /** Tells the server this phone stops getting the account's pushes. Signs in with the in-memory JWT. */
    releasePush?: () => Promise<void>;
    /** Revokes the session server-side. May fail, or never answer, with no network. */
    revokeSession: (token: string) => Promise<void>;

    /**
     * Clears the stored session (the keychain item the iOS notification extension also reads) and resolves its token,
     * or `undefined`. Runs before anything waits on the network.
     */
    takeCredential: () => Promise<string | undefined>;
    warn: (message: string, error: unknown) => void;
}

/**
 * Signing out takes the person's saved chats off the device FIRST, locally, before the server is asked anything: a
 * sign-out request that fails or hangs offline must not leave their chats behind for the next person to open.
 *
 * Then the stored session, still locally: from here on nothing on the phone can sign in as them, so the notification
 * extension cannot fetch their notifications' text either; and their notifications already on the phone are removed.
 * Then the phone's push token is released with the sign-in
 * still held in memory, waited on for at most {@link RELEASE_PUSH_TIMEOUT_MS} (if that fails, the next account to sign
 * in on this phone takes the token over), and last the session is revoked server-side.
 */
export const signOutOnDevice = async ({
    clearCache,
    dismissNotifications,
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
        // The stored grant could not be cleared. The user is still signed out in memory by the caller, and the session
        // is still revoked below with the token the failed clear carries, so the grant left behind stops working.
        warn("Could not clear the stored sign-in.", error);
        token = tokenOf(error);
    }

    if (dismissNotifications) {
        try {
            await dismissNotifications();
        } catch (error) {
            warn("Could not remove this account's notifications.", error);
        }
    }

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

    if (token !== undefined) {
        try {
            await revokeSession(token);
        } catch {
            // Offline: the session expires on its own, and nothing on the phone holds it any more.
        }
    }
};

/**
 * Runs whenever the app finds nobody signed in (at launch, or when a refresh finds no grant or the server rejects it):
 * empties the offline cache and forgets the saved chat again, so a wipe that failed at sign-out (a locked or full disk),
 * or a session that ended without one, cannot leave the last account's chats on the device until someone signs in.
 * Never blocks: a failure only warns, and the next signed-out start tries again.
 */
export const emptyCacheWhileSignedOut = async ({
    clearCache,
    dismissNotifications,
    forgetLastChat,
    warn,
}: Pick<SignOutSteps, "clearCache" | "dismissNotifications" | "forgetLastChat" | "warn">): Promise<void> => {
    // The forget is queued at once, not after the cache wipe: the sign-in screen is already up, and a chat saved by a
    // quick sign-in must queue after this forget, or the forget would delete it. A session the SERVER ended (a refresh
    // answered 401) never ran the sign-out above, so the previous account's alerts are removed here too.
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
