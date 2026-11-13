/** How long sign-out waits for the server to drop this phone's push token before it carries on without it. */
export const RELEASE_PUSH_TIMEOUT_MS = 5000;

interface SignOutSteps {
    /** Empties the offline cache. */
    clearCache: () => Promise<void>;
    /** Forgets the chat saved to reopen on launch. */
    forgetLastChat: () => Promise<void>;
    /** Tells the server this phone stops getting the account's pushes. Needs the sign-in, so it runs before the revoke. */
    releasePush?: () => Promise<void>;
    /** Tells the server and clears the stored grant. May fail, or never answer, with no network. */
    revokeGrant: () => Promise<void>;
    warn: (message: string, error: unknown) => void;
}

/**
 * Signing out takes the person's saved chats off the device FIRST, locally, before the server is asked anything: a
 * sign-out request that fails or hangs offline must not leave their chats behind for the next person to open.
 *
 * Then the phone's push token is released while the sign-in still works, waited on for at most
 * {@link RELEASE_PUSH_TIMEOUT_MS}: the server stops sending once the session is revoked anyway, so a release that
 * fails or hangs only means the row waits for the next send to be dropped. Last the grant is revoked and cleared.
 */
export const signOutOnDevice = async ({ clearCache, forgetLastChat, releasePush, revokeGrant, warn }: SignOutSteps): Promise<void> => {
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

    try {
        await revokeGrant();
    } catch (error) {
        // The stored grant could not be cleared. The user is still signed out in memory by the caller.
        warn("Could not clear the stored sign-in.", error);
    }
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
