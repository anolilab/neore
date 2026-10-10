/**
 * The URL a vault row is SHOWN with — minted on read, never stored.
 *
 * `files.url` used to hold `<R2_PUBLIC_URL_BASE>/<key>`: every upload was
 * world-readable by key. A row with a `key` now gets a short-lived signed GET
 * (`lib/signed-storage.ts` serves it) with a query-stable expiry
 * (`displayUrlExpiresInSeconds`). A row without a key keeps a stored URL only
 * when it points somewhere else (a provider's CDN); one that points at this
 * deployment's own storage is useless without a signature and is dropped.
 */
import { displayUrlExpiresInSeconds, issuedStorageOrigins, storageKeyOf } from "../../lib/storage-ref";
import type { SignerSource } from "../../lib/storage-sign";
import { trySign } from "../../lib/storage-sign";

/**
 * Pass `storage` as `() => ctx.storage` (see `SignerSource`): a thumbnail that
 * cannot be signed must not fail the whole listing — the row is still shown,
 * unpreviewed.
 */
export const displayUrlForFile = async (
    storage: SignerSource,
    row: { key?: string; url?: string },
    nowMs: number = Date.now(),
): Promise<string | undefined> => {
    const key = row.key ?? storageKeyOf(row.url, issuedStorageOrigins()) ?? undefined;

    if (key) {
        return (await trySign(storage, key, displayUrlExpiresInSeconds(nowMs))) ?? undefined;
    }

    if (!row.url) {
        return undefined;
    }

    try {
        const host = new URL(row.url);

        return issuedStorageOrigins().some((origin) => new URL(origin).origin === host.origin) ? undefined : row.url;
    } catch {
        return undefined;
    }
};

/** Map rows to their display shape, signing each. */
export const withDisplayUrls = async <R extends { key?: string; url?: string }>(storage: SignerSource, rows: ReadonlyArray<R>): Promise<R[]> => {
    const nowMs = Date.now();

    return await Promise.all(
        rows.map(async (row) => {
            const url = await displayUrlForFile(storage, row, nowMs);

            return { ...row, url };
        }),
    );
};
