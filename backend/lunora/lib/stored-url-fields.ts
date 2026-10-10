/**
 * Storage references inside free-form JSON: workflow graphs (`projects.workflowContent`,
 * `workflowVersions.content`, `workflowExecutions.workflowSnapshot`) and node
 * execution inputs/outputs (`nodeExecutions`).
 *
 * The same rule as messages (`lib/storage-ref.ts`, `agent/stored-media.ts`):
 * persist `storage:<key>`, sign on read. Only fields whose NAME says they hold
 * a URL (`url`, `imageUrl`, `maskUrl`, `fileUrl`, `imageUrls`, …) are touched — a
 * text node's `content`, a prompt, a node's text output are user-authored, and
 * a reference typed there must never turn into a working link.
 *
 * Thin wrappers over `lib/storage-sign.ts` with the URL-field selector.
 *
 * URL-named fields are user-controlled too: anyone can save a graph whose
 * `imageUrl` is `storage:<someone else's key>`. So the paths that persist or
 * read USER data go through the `owned*` variants, which keep and sign only
 * keys the data's owner has a claim to (`lib/storage-ownership.ts`) and strip
 * the rest to {@link UNAVAILABLE_STORAGE_URL} — on write, and again on read,
 * which is what covers a fork copying someone else's references.
 */
import type { QueryCtx } from "../_generated/server";
import { ownedStorageKeys } from "./storage-ownership";
import type { Signer, SignerSource } from "./storage-sign";
import { collectStrings, displaySign, isUrlFieldName, mapStrings, signStorageStrings, storageRefsIn } from "./storage-sign";
import { issuedStorageOrigins, storageKeyOf } from "./storage-ref";
import { systemDb } from "./rls/scope";

/** For PERSISTING: signed URLs to our storage in URL-named fields become `storage:` references. */
export const storageRefsInUrlFields = <T>(value: T, origins?: ReadonlyArray<string>): T => storageRefsIn(value, { origins, select: isUrlFieldName });

/**
 * For READING: every storage reference (or older URL to our storage) in a
 * URL-named field becomes a fresh signed URL. `sign` is called once per key.
 */
export const signUrlFields = async <T>(value: T, options: { origins?: ReadonlyArray<string>; sign: (key: string) => Promise<string | null> }): Promise<T> =>
    await signStorageStrings(value, { ...options, select: isUrlFieldName });

/**
 * `signUrlFields` for a QUERY result: query-stable expiry, and an unsignable
 * reference (no storage bound — pass `() => ctx.storage`) left as stored rather
 * than failing the read.
 */
export const signUrlFieldsForDisplay = async <T>(storage: SignerSource, value: T): Promise<T> => await signUrlFields(value, { sign: displaySign(storage) });

/** What a URL-named field naming storage its owner has no claim to becomes. */
export const UNAVAILABLE_STORAGE_URL = "";

/** Every storage key a URL-named field names, as a reference or as a URL to our storage. */
export const storageKeysInUrlFields = (value: unknown, origins: ReadonlyArray<string> = issuedStorageOrigins()): Set<string> =>
    new Set(
        collectStrings(value, isUrlFieldName)
            .map((text) => storageKeyOf(text, origins))
            .filter((key): key is string => key !== null),
    );

/** Strip every URL-named field that names a key outside `allowed`. */
const stripForeignKeys = <T>(value: T, allowed: ReadonlySet<string>, origins: ReadonlyArray<string>): T =>
    mapStrings(
        value,
        (text) => {
            const key = storageKeyOf(text, origins);

            return key === null || allowed.has(key) ? text : UNAVAILABLE_STORAGE_URL;
        },
        isUrlFieldName,
    ) as T;

type OwnershipContext = Pick<QueryCtx, "db">;

/** `value` with every URL-named field naming storage `ownerId` does not own stripped. */
const keepOwnedKeys = async <T>(context: OwnershipContext, ownerId: string | undefined, value: T, origins: ReadonlyArray<string>): Promise<T> => {
    if (value === undefined || value === null) {
        return value;
    }

    const keys = storageKeysInUrlFields(value, origins);

    if (keys.size === 0) {
        return value;
    }

    // Data with no owner (a row predating the column) owns nothing.
    // An ownership DECISION about `ownerId` (a public workflow's author, for its
    // viewer): read past row-level security.
    return stripForeignKeys(value, ownerId ? await ownedStorageKeys(systemDb(context), ownerId, keys) : new Set<string>(), origins);
};

/**
 * For PERSISTING user-controlled JSON owned by `ownerId`: `storageRefsInUrlFields`,
 * after stripping every reference or URL to storage they do not own.
 */
export const ownedStorageRefsInUrlFields = async <T>(
    context: OwnershipContext,
    ownerId: string | undefined,
    value: T,
    origins: ReadonlyArray<string> = issuedStorageOrigins(),
): Promise<T> => storageRefsInUrlFields(await keepOwnedKeys(context, ownerId, value, origins), origins);

/**
 * For READING data `ownerId` wrote: `signUrlFieldsForDisplay`, signing only
 * keys they own and stripping the rest. `ownerId` is the DATA's owner — for a
 * shared view, the workflow's author, never the viewer.
 */
export const signOwnedUrlFieldsForDisplay = async <T>(
    context: OwnershipContext & { readonly storage: Signer },
    ownerId: string | undefined,
    value: T,
): Promise<T> =>
    // `storage` is read inside the thunk: it is a getter that throws where none is bound.
    await signUrlFieldsForDisplay(() => context.storage, await keepOwnedKeys(context, ownerId, value, issuedStorageOrigins()));
