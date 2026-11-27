/**
 * The stored grant could not be cleared. It carries the session token it read, so sign-out still revokes the session
 * server-side: a grant left in the keychain must at least stop working.
 */
export class StoredGrantNotClearedError extends Error {
    public readonly token: string | undefined;

    public constructor(token: string | undefined, cause: unknown) {
        super(`The stored sign-in could not be cleared: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = "StoredGrantNotClearedError";
        this.token = token;
    }
}
