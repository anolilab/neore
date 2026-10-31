interface SignOutSteps {
    /** Empties the offline cache. */
    clearCache: () => Promise<void>;
    /** Tells the server and clears the stored grant. May fail, or never answer, with no network. */
    revokeGrant: () => Promise<void>;
    warn: (message: string, error: unknown) => void;
}

/**
 * Signing out takes the person's saved chats off the device FIRST, locally, before the server is asked anything: a
 * sign-out request that fails or hangs offline must not leave their chats behind for the next person to open.
 */
export const signOutOnDevice = async ({ clearCache, revokeGrant, warn }: SignOutSteps): Promise<void> => {
    try {
        await clearCache();
    } catch (error) {
        warn("Could not empty the offline cache.", error);
    }

    try {
        await revokeGrant();
    } catch (error) {
        // The stored grant could not be cleared. The user is still signed out in memory by the caller.
        warn("Could not clear the stored sign-in.", error);
    }
};
