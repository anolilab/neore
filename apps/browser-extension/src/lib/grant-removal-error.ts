/** Storage kept a grant whose sign-out ran: it is marked signed out, so nothing reads it again. */
export class GrantRemovalError extends Error {
    /** The key of the grant left stored (`grantKey`). */
    public readonly key: string;

    public constructor(cause: unknown, key: string) {
        super(cause instanceof Error ? cause.message : "The grant could not be removed.", { cause });
        this.name = "GrantRemovalError";
        this.key = key;
    }
}
