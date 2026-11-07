import { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { Platform } from "react-native";

import type { GrantStore, StoredGrant } from "./grant";
import type { KeychainWriteOps } from "./shared-keychain";
import { createKeychainWriteOps, untilItWorks, upgradeGrantInPlace } from "./shared-keychain";

const KEY = "neore.mobile.grant";

/**
 * The session token at rest, in the iOS Keychain / Android Keystore. The JWT is never stored.
 *
 * Readable after the first unlock, on this device only: the iOS Notification Service Extension
 * signs in with it to fetch a push's text, and pushes mostly arrive on a locked phone. It stays
 * out of backups and off a new device. The extension reads it from the app's own keychain group.
 */
export const SHARED_KEYCHAIN_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Writes over an existing item in place (an expo-secure-store update), readable after the first unlock. */
export const sharedKeychainOps: KeychainWriteOps = createKeychainWriteOps({
    accessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    getItem: getItemAsync,
    setItem: setItemAsync,
});

/**
 * Before the store is first used: a grant stored before this build is readable only while unlocked, so a push
 * arriving on a locked phone would keep the placeholder. It is rewritten over itself, in place and only once
 * (`upgradeGrantInPlace`), never deleted, so the person is signed in at every moment. A failed attempt is tried again
 * on the next use of the store. Every read, write and clear waits for it.
 */
const upgradeOnce = untilItWorks(async () => {
    if (Platform.OS === "ios") {
        await upgradeGrantInPlace(KEY, sharedKeychainOps);
    }
});

const ensureReadableWhenLocked = async (): Promise<void> => {
    try {
        await upgradeOnce();
    } catch (error) {
        // eslint-disable-next-line no-console -- no logger in the app; pushes on a locked phone keep the placeholder until it works
        console.warn("Could not make the sign-in readable by the notification extension.", error);
    }
};

export const secureGrantStore: GrantStore = {
    clear: async () => {
        await ensureReadableWhenLocked();
        await deleteItemAsync(KEY);
    },
    get: async () => {
        await ensureReadableWhenLocked();

        const raw = await getItemAsync(KEY);

        if (raw === null) {
            // eslint-disable-next-line unicorn/no-null -- `GrantStore.get` answers null when signed out; the callers compare with null
            return null;
        }

        try {
            return JSON.parse(raw) as StoredGrant;
        } catch {
            // A damaged value can never sign anyone in: drop it, so the session reads as signed out.
            await deleteItemAsync(KEY);

            // eslint-disable-next-line unicorn/no-null -- same contract as above: a signed-out result is null
            return null;
        }
    },
    set: async (grant) => {
        await ensureReadableWhenLocked();
        await setItemAsync(KEY, JSON.stringify(grant), SHARED_KEYCHAIN_OPTIONS);
    },
};
