/**
 * An R2 client shaped over Lunora's `ctx.storage`.
 *
 * The original component took its binding at construction and took the
 * context as its first argument (`r2.deleteObject(ctx, key)`). Lunora puts the
 * bucket on the context instead (`ctx.storage.delete(key)`), which is the better
 * shape — but there are ~20 call sites in the component's shape, and rewriting
 * each by hand risks more than it gains.
 *
 * So this is a signature adapter, nothing more. Every method forwards straight to
 * `ctx.storage`; there is no state and no behaviour of its own.
 *
 * The component's `clientApi({ checkUpload, onUpload, onSyncMetadata })` codegen
 * is NOT reproduced — those three generated functions are written out explicitly
 * in `vault/functions.ts`, where the auth check and the row bookkeeping they
 * hid are worth being able to read.
 */

/**
 * Read and write are separate context requirements.
 *
 * Lunora types `ctx.storage` as `ReadOnlyStorage` in queries and mutations, and
 * only actions get `delete` / `store` (see
 * `lib/storageCleanup.ts` for why). A single `StorageCtx` demanding all four
 * therefore rejected every mutation that only wanted to READ metadata — ten
 * errors, all of the form "ReadOnlyStorage is missing delete, generateUploadUrl",
 * pointing at call sites that were doing nothing wrong.
 */
interface ReadStorageContext {
    storage: {
        getMetadata: (key: string) => Promise<null | { contentType?: string; size?: number }>;
        getUrl: (key: string) => string;
    };
}

interface WriteStorageContext extends ReadStorageContext {
    storage: ReadStorageContext["storage"] & {
        delete: (key: string) => Promise<void>;
    };
}

export const r2 = {
    /** Action-only — a mutation cannot delete (the delete is not transactional). */
    deleteObject: async (context: WriteStorageContext, key: string): Promise<void> => await context.storage.delete(key),

    getMetadata: async (context: ReadStorageContext, key: string): Promise<null | { contentType?: string; size?: number }> =>
        await context.storage.getMetadata(key),

    getUrl: (context: ReadStorageContext, key: string): string => context.storage.getUrl(key),
};

export default r2;
