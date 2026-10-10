/**
 * Storage references: what gets PERSISTED where a stored object is mentioned.
 *
 * A message part or a `files` row must not hold a URL. A public URL makes the
 * object world-readable; a signed one expires, so a message saved with it can
 * no longer show its image, and a follow-up turn hands the model a dead link.
 * What is stored instead is `storage:<key>`, and a fresh signed URL is minted
 * at the moment something needs one — the context builder for a model call
 * (`agent/stored-media.ts`), a query for display. The walkers that apply this
 * rule to whole values live in `lib/storage-sign.ts`.
 *
 * Rows written before this carry URLs. `storageKeyOf` recovers the key from any
 * URL this deployment issued under its own origin — a Worker-signed one
 * (`<PUBLIC_ORIGIN>/<key>?sig=`) or the never-served unsigned `getUrl` form — so
 * old rows are re-signed too. A URL from anywhere else (a provider CDN, the
 * retired public bucket) is left alone; nothing was ever deployed with the
 * bucket, so no row needs it.
 */

export const STORAGE_REF_PREFIX = "storage:";

export const toStorageRef = (key: string): string => `${STORAGE_REF_PREFIX}${key}`;

export const isStorageRef = (value: unknown): value is string =>
    typeof value === "string" && value.startsWith(STORAGE_REF_PREFIX) && value.length > STORAGE_REF_PREFIX.length;

/** Keys storage itself mints: content-addressed chat files and `randomUUID()` uploads. */
const MINTED_KEY = /^(?:agent-files\/[\da-f]{64}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/u;

const isMintedKeyShape = (key: string): boolean => MINTED_KEY.test(key);

/** Keys are opaque, but never empty, never absolute, never traversing. */
const isPlausibleKey = (key: string): boolean => key.length > 0 && key.length <= 512 && !key.startsWith("/") && !key.split("/").includes("..");

const UNIX_SECONDS = /^\d+$/u;

/** `?exp=<int>&method=GET&bucket=<name>&sig=<hmac>` — what `ctx.storage.getSignedUrl` mints. */
const hasSignedUrlShape = (url: URL): boolean => {
    const { searchParams } = url;
    const exp = searchParams.get("exp");

    return (
        Boolean(searchParams.get("sig")) &&
        Boolean(searchParams.get("bucket")) &&
        searchParams.get("method") === "GET" &&
        exp !== null &&
        UNIX_SECONDS.test(exp)
    );
};

/**
 * The storage key `value` refers to, or `null`. `origins` are the bases this
 * deployment has issued object URLs under (`issuedStorageOrigins()`: its own
 * origin). A base may carry a path prefix, which is stripped from the key.
 */
export const storageKeyOf = (value: unknown, origins: ReadonlyArray<string>): string | null => {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }

    if (isStorageRef(value)) {
        const key = value.slice(STORAGE_REF_PREFIX.length);

        return isPlausibleKey(key) ? key : null;
    }

    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return null;
    }

    for (const origin of origins) {
        let base: URL;

        try {
            base = new URL(origin);
        } catch {
            continue;
        }

        const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

        if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
            continue;
        }

        let key: string;

        try {
            key = decodeURIComponent(url.pathname.slice(prefix.length));
        } catch {
            return null;
        }

        // Only URLs that actually name an object: a signed one, or the unsigned
        // `getUrl` form of a key shape storage mints. Any other path on this
        // origin (an API link a tool returned) is not storage and is left alone.
        // "Signed" means the whole parameter set storage emits, not a bare
        // `?sig=` anyone can append to any path. That is a shape check only —
        // it cannot verify the HMAC (expired URLs would fail it, and this is
        // sync) — so a key recovered here is a CLAIM: data a user wrote must
        // still pass an ownership check before it is signed
        // (`lib/storage-ownership.ts`).
        const isSigned = hasSignedUrlShape(url);

        return isPlausibleKey(key) && (isSigned || isMintedKeyShape(key)) ? key : null;
    }

    return null;
};

/** Seconds; see {@link displayUrlExpiresInSeconds}. */
const DISPLAY_WINDOW_SECONDS = 6 * 60 * 60;
const DISPLAY_MIN_VALIDITY_SECONDS = 12 * 60 * 60;

/**
 * `expiresInSeconds` for a signed URL returned by a QUERY.
 *
 * A reactive query's result is cached and re-delivered until its data changes,
 * so a URL minted with a plain relative expiry would differ on every run (and
 * defeat the cache) while a cached copy could outlive it. Rounding the absolute
 * expiry up to a 6-hour boundary at least 12 hours out makes the URL identical
 * for every run inside a window and valid for 12-18 hours after it was served.
 */
export const displayUrlExpiresInSeconds = (nowMs: number = Date.now()): number => {
    const nowSeconds = Math.floor(nowMs / 1000);
    const expiresAt = Math.ceil((nowSeconds + DISPLAY_MIN_VALIDITY_SECONDS) / DISPLAY_WINDOW_SECONDS) * DISPLAY_WINDOW_SECONDS;

    return expiresAt - nowSeconds;
};

/** The bases this deployment has issued object URLs under: its own origin. */
export const issuedStorageOrigins = (): string[] => {
    const origin = process.env.PUBLIC_ORIGIN?.trim();

    return origin ? [origin] : [];
};
