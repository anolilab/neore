import { getAccessToken } from "./access-token";
import { createAuthTokenSync } from "./auth-token-sync";
import { lunora } from "./lunora-client";
import { endSession } from "./session";

/** The one bearer sync for this panel's Lunora client (`createAuthTokenSync`). */
export const authTokenSync = createAuthTokenSync(lunora, getAccessToken);

/** Sign out the grant `key` names, the session shown (`endSession`); rejects when the grant stays stored. */
export const signOut = async (key: string): Promise<void> => {
    await endSession(authTokenSync, key);
};
