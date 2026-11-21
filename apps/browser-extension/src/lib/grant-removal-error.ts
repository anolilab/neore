/** Storage kept a grant whose sign-out ran. `revoked` when the server had confirmed the revoke: the grant is dead. */
export class GrantRemovalError extends Error {
    public readonly revoked: boolean;

    public constructor(cause: unknown, revoked: boolean) {
        super(cause instanceof Error ? cause.message : "The grant could not be removed.", { cause });
        this.name = "GrantRemovalError";
        this.revoked = revoked;
    }
}
