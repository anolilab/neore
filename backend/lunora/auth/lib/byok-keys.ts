/**
 * BYOK key entries on `aiUserPreferences` (`providerApiKeys`, `generalProviders`,
 * `messengerKeys`, `customAIProviders`): how writes merge and what reads expose.
 *
 * The rule: plaintext enters ONLY through an explicit per-entry `key` input
 * (`"sk-…"` = set, `""` = clear). Ciphertext never leaves the server — reads go
 * through {@link redactKeyEntries} — and anything the client echoes back in
 * `encryptedKey` is ignored. Before this, the settings UI round-tripped every
 * stored ciphertext and the write path encrypted whatever `encryptedKey` it was
 * handed, so saving key B double-encrypted key A.
 */

/** One entry as it sits in the (`v.any()`) column. */
export interface StoredKeyEntry {
    [field: string]: unknown;
    createdAt?: number;
    enabled: boolean;
    /** `v1:` ciphertext, or `""` for no key. */
    encryptedKey: string;
    keyVersion?: number;
    /** Last four characters of the plaintext, for display. Only kept for keys ≥ 12 chars. */
    last4?: string;
    lastRotatedAt?: number;
}

/** One entry as the client sends it. `key` omitted = keep the stored key. */
export interface KeyEntryInput {
    [field: string]: unknown;
    enabled: boolean;
    key?: string;
}

/** One entry as the client sees it. */
export interface RedactedKeyEntry {
    [field: string]: unknown;
    createdAt?: number;
    enabled: boolean;
    hasKey: boolean;
    keyVersion?: number;
    last4?: string;
    lastRotatedAt?: number;
}

/** Server-owned fields: never taken from input. */
const SERVER_FIELDS = new Set(["createdAt", "encryptedKey", "hasKey", "keyVersion", "last4", "lastRotatedAt"]);

const LAST4_MIN_LENGTH = 12;

export const lastFour = (plaintext: string): string | undefined => (plaintext.length >= LAST4_MIN_LENGTH ? plaintext.slice(-4) : undefined);

const withoutUndefined = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/**
 * Merge a client-supplied entry set with what is stored.
 *
 * The input REPLACES the entry set (an entry absent from input is dropped —
 * that is how the UI deletes one). Per entry: a non-empty `key` is encrypted,
 * `""` clears, and an omitted `key` keeps the stored ciphertext and its
 * metadata untouched.
 */
export const mergeKeyEntries = async (
    input: Record<string, KeyEntryInput | undefined>,
    stored: Record<string, StoredKeyEntry> | undefined,
    encrypt: (plaintext: string) => Promise<string>,
    options: { now: number; stampMetadata: boolean },
): Promise<Record<string, StoredKeyEntry>> => {
    const out: Record<string, StoredKeyEntry> = {};

    for (const [name, entry] of Object.entries(input)) {
        if (!entry) {
            continue;
        }

        const rest = Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "key" && !SERVER_FIELDS.has(field))) as { enabled: boolean };
        const previous = stored?.[name];
        const plaintext = typeof entry.key === "string" ? entry.key.trim() : undefined;

        if (plaintext) {
            const hadKey = Boolean(previous?.encryptedKey);

            out[name] = withoutUndefined({
                ...rest,
                encryptedKey: await encrypt(plaintext),
                last4: lastFour(plaintext),
                ...(options.stampMetadata && {
                    createdAt: hadKey ? (previous?.createdAt ?? options.now) : options.now,
                    keyVersion: 1,
                    lastRotatedAt: options.now,
                }),
            });
        } else if (plaintext === "" || !previous?.encryptedKey) {
            out[name] = { ...rest, encryptedKey: "" };
        } else {
            out[name] = withoutUndefined({
                ...rest,
                createdAt: previous.createdAt,
                encryptedKey: previous.encryptedKey,
                keyVersion: previous.keyVersion,
                last4: previous.last4,
                lastRotatedAt: previous.lastRotatedAt,
            });
        }
    }

    return out;
};

/** Strip ciphertext from an entry set; `hasKey` says whether one is stored. */
export const redactKeyEntries = (stored: unknown): Record<string, RedactedKeyEntry> | undefined => {
    if (!stored || typeof stored !== "object") {
        return undefined;
    }

    const out: Record<string, RedactedKeyEntry> = {};

    for (const [name, entry] of Object.entries(stored as Record<string, StoredKeyEntry | undefined>)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const { encryptedKey, ...rest } = entry;

        out[name] = { ...rest, hasKey: typeof encryptedKey === "string" && encryptedKey.length > 0 };
    }

    return out;
};

/** The `aiUserPreferences` columns that hold key entries. */
export const KEY_ENTRY_FIELDS = ["customAIProviders", "generalProviders", "messengerKeys", "providerApiKeys"] as const;

/** Redact every key column of a preferences doc IN PLACE — the only shape a client may receive. */
export const redactPreferences = (doc: Record<string, unknown>): void => {
    for (const field of KEY_ENTRY_FIELDS) {
        if (field in doc) {
            doc[field] = redactKeyEntries(doc[field]);
        }
    }
};
