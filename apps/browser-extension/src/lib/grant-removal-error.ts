/** Storage kept a grant whose sign-out ran: it is marked signed out, so nothing reads it again. */
export class GrantRemovalError extends Error {
    public constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : "The grant could not be removed.", { cause });
        this.name = "GrantRemovalError";
    }
}
