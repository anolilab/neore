/**
 * Keychain writes for the items the iOS Notification Service Extension reads. Kept
 * free of the native module so the write path can be tested; the glue is
 * `secure-store.ts`.
 *
 * The app and the extension share the app's OWN default keychain group (its
 * application identifier, `app.config.ts`), so an item the app wrote before this
 * build is already where the extension looks: nothing ever moves between groups,
 * and nothing is ever deleted to be written again. What can differ on such an old
 * item is its accessibility (it was written readable only while unlocked); that is
 * changed in place, by writing the same key again, which expo-secure-store turns
 * into a `SecItemUpdate` of the existing item.
 */

export interface KeychainWriteOps {
    read: (key: string) => Promise<string | null>;
    /** Writes `value` over `key` in the same group, readable after the first unlock: an update when it exists. */
    writeInPlace: (key: string, value: string) => Promise<void>;
}

/** Set once the stored grant has been made readable after the first unlock. */
export const GRANT_ACCESSIBILITY_MARKER = "neore.mobile.grant-after-first-unlock";

/**
 * Makes a grant stored before this build readable on a locked phone, once: when the
 * marker says it is done, nothing is written. Never deletes. Resolves whether the
 * grant was written.
 */
export const upgradeGrantInPlace = async (key: string, ops: KeychainWriteOps): Promise<boolean> => {
    if (await ops.read(GRANT_ACCESSIBILITY_MARKER) === "1") {
        return false;
    }

    const value = await ops.read(key);

    if (value !== null) {
        await ops.writeInPlace(key, value);
    }

    await ops.writeInPlace(GRANT_ACCESSIBILITY_MARKER, "1");

    return value !== null;
};

/** Writes `value` only when the stored one differs. Resolves whether it wrote. */
export const writeIfDifferent = async (key: string, value: string, ops: KeychainWriteOps): Promise<boolean> => {
    if (await ops.read(key) === value) {
        return false;
    }

    await ops.writeInPlace(key, value);

    return true;
};

/**
 * The in-place writer over expo-secure-store. EVERY write carries `keychainAccessible`: on an
 * existing item expo-secure-store falls back from `SecItemAdd` to `SecItemUpdate`, and it puts
 * `kSecAttrAccessible` into that update only when the option is given (otherwise "keychain updates
 * keep the existing access settings"). Without it an old grant would stay readable only while unlocked.
 */
export const createKeychainWriteOps = <Accessible>(store: {
    accessible: Accessible;
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string, options: { keychainAccessible: Accessible }) => Promise<void>;
}): KeychainWriteOps => {
    return {
        read: store.getItem,
        writeInPlace: async (key, value) => {
            await store.setItem(key, value, { keychainAccessible: store.accessible });
        },
    };
};

/**
 * Runs `step` until it has worked once. Callers at the same time share one attempt; a
 * failed attempt is not kept, so the next caller tries again instead of waiting for the
 * app to restart.
 */
export const untilItWorks = (step: () => Promise<unknown>): () => Promise<void> => {
    const state: { attempt?: Promise<void>; isDone: boolean } = { isDone: false };

    return async () => {
        if (state.isDone) {
            return;
        }

        state.attempt ??= (async () => {
            try {
                await step();
                state.isDone = true;
            } finally {
                state.attempt = undefined;
            }
        })();

        await state.attempt;
    };
};
