/**
 * Signing stored objects for READ, and turning our own signed URLs back into
 * `storage:` references for PERSISTENCE — the two halves of the rule in
 * `lib/storage-ref.ts`, shared by every place that applies it:
 *
 * - free-form JSON (`lib/stored-url-fields.ts`) walks only URL-NAMED fields;
 * - tool results (`storageRefsForUrls`, `agent/stored-media.ts`) walk every string;
 * - vault rows (`vault/lib/display-url.ts`) sign a single key.
 *
 * One {@link Signer} type, one tree walker ({@link mapStrings}, parameterised by
 * which fields it descends into), and one answer to "`ctx.storage` may throw"
 * ({@link trySign}).
 */
import { displayUrlExpiresInSeconds, issuedStorageOrigins, storageKeyOf, toStorageRef } from "./storage-ref";

/** The slice of `ctx.storage` that mints a signed GET. */
export interface Signer {
    /** Signs a GET — the default method, and the only one `ctx.storage`'s type exposes. */
    getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
}

/**
 * A signer, or a thunk for one. Pass `() => ctx.storage` where a failure to
 * sign must not fail the caller: `ctx.storage` is a getter that THROWS where no
 * storage is bound (the in-memory test harness).
 */
export type SignerSource = Signer | (() => Signer);

/**
 * A signed URL for `key`, or `null` when none can be minted — the thunk threw
 * (no storage bound) or signing rejected. Display paths use this so an
 * unsignable object degrades to "shown as stored" / "unpreviewed" rather than
 * failing the whole read.
 */
export const trySign = async (source: SignerSource, key: string, expiresInSeconds: number): Promise<string | null> => {
    try {
        const signer = typeof source === "function" ? source() : source;

        return await signer.getSignedUrl(key, { expiresInSeconds });
    } catch {
        return null;
    }
};

/**
 * Which record fields' strings a walk touches, by field name. `undefined`
 * means every string, at any depth.
 */
export type FieldSelector = (fieldName: string) => boolean;

const URL_FIELD_NAME = /urls?$/iu;

/** `url`, `imageUrl`, `maskUrl`, `fileUrl`, … and lists of them (`imageUrls`). */
export const isUrlFieldName: FieldSelector = (fieldName) => URL_FIELD_NAME.test(fieldName);

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Apply `replace` to every selected string in a JSON-ish tree. With a
 * `select`or, a string counts only when the nearest enclosing record field
 * matches it (an array under such a field counts too); a bare root string does
 * not. Without one, every string counts.
 */
export const mapStrings = (value: unknown, replace: (text: string) => string, select?: FieldSelector, selected: boolean = select === undefined): unknown => {
    if (typeof value === "string") {
        return selected ? replace(value) : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => mapStrings(item, replace, select, selected));
    }

    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, replace, select, select ? select(key) : true)]));
    }

    return value;
};

/** Every string {@link mapStrings} would visit. */
export const collectStrings = (value: unknown, select?: FieldSelector): string[] => {
    const strings: string[] = [];

    mapStrings(
        value,
        (text) => {
            strings.push(text);

            return text;
        },
        select,
    );

    return strings;
};

/**
 * For PERSISTING: every signed URL to our own storage (among the selected
 * strings) becomes a `storage:` reference, so the stored row never holds a link
 * that expires. Everything else is returned unchanged.
 */
export const storageRefsIn = <T>(value: T, options: { origins?: ReadonlyArray<string>; select?: FieldSelector } = {}): T => {
    const origins = options.origins ?? issuedStorageOrigins();

    if (origins.length === 0 || value === undefined || value === null) {
        return value;
    }

    return mapStrings(
        value,
        (text) => {
            const key = text.includes("sig=") ? storageKeyOf(text, origins) : null;

            return key ? toStorageRef(key) : text;
        },
        options.select,
    ) as T;
};

/**
 * For PERSISTING a tool result: every string is considered. The model saw the
 * signed URL in its own turn; later turns and the UI get a fresh one from
 * `agent/stored-media.ts`.
 */
export const storageRefsForUrls = <T>(value: T, origins: ReadonlyArray<string> = issuedStorageOrigins()): T => storageRefsIn(value, { origins });

/**
 * For READING: every storage reference (or older URL to our storage) among the
 * selected strings becomes a fresh signed URL. `sign` is called once per key;
 * a key it returns `null` for keeps its stored value.
 */
export const signStorageStrings = async <T>(
    value: T,
    options: { origins?: ReadonlyArray<string>; select?: FieldSelector; sign: (key: string) => Promise<string | null> },
): Promise<T> => {
    if (value === undefined || value === null) {
        return value;
    }

    const origins = options.origins ?? issuedStorageOrigins();
    const keys = new Set(
        collectStrings(value, options.select)
            .map((text) => storageKeyOf(text, origins))
            .filter((key): key is string => key !== null),
    );

    if (keys.size === 0) {
        return value;
    }

    const signed = new Map<string, string>();

    await Promise.all(
        [...keys].map(async (key) => {
            const url = await options.sign(key);

            if (url !== null) {
                signed.set(key, url);
            }
        }),
    );

    return mapStrings(
        value,
        (text) => {
            const key = storageKeyOf(text, origins);

            return (key && signed.get(key)) ?? text;
        },
        options.select,
    ) as T;
};

/** A `sign` for a QUERY result: query-stable expiry, and an unsignable key left as stored. */
export const displaySign =
    (source: SignerSource, nowMs: number = Date.now()): ((key: string) => Promise<string | null>) =>
    async (key) =>
        await trySign(source, key, displayUrlExpiresInSeconds(nowMs));
