/**
 * Display-side counterpart of the context builder's signing: re-sign the media
 * in messages a QUERY is about to return (`agent/stored-media.ts`).
 *
 * Queries may sign — `ReadOnlyStorage` keeps `getSignedUrl`, which is HMAC only,
 * no R2 round trip — but a query's result is cached, so the expiry is bucketed
 * (`displayUrlExpiresInSeconds`) to keep the URLs identical across re-runs.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ownedStorageKeys } from "../lib/storage-ownership";
import { displayUrlExpiresInSeconds, issuedStorageOrigins } from "../lib/storage-ref";
import type { MediaDoc } from "./stored-media";
import { resolveDocsStoredMedia } from "./stored-media";
import { systemDb } from "../lib/rls/scope";

export const signDocsForDisplay = async <D extends MediaDoc>(context: Pick<QueryCtx, "db" | "storage">, docs: ReadonlyArray<D>): Promise<D[]> => {
    const expiresInSeconds = displayUrlExpiresInSeconds();

    return await resolveDocsStoredMedia(docs, {
        // One read for the page, not one per file: `chatFiles` is `.global()`,
        // so each read is a D1 round trip.
        lookupKeys: async (fileIds) => {
            const { page: files } = await context.db.chatFiles.findMany({ where: { _id: { in: fileIds as Id<"chatFiles">[] } } });

            return new Map(files.map((file) => [file._id as string, file.storageId]));
        },
        // An ownership DECISION about the message author, who need not be the viewer
        // (a thread grantee, a public share): read past row-level security.
        lookupOwnedKeys: async (userId, keys) => await ownedStorageKeys(systemDb(context), userId, keys),
        origins: issuedStorageOrigins(),
        sign: async (key) => await context.storage.getSignedUrl(key, { expiresInSeconds }),
    });
};
