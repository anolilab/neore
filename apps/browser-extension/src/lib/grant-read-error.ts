/** Storage failed to read whether a marked grant is left over: nothing was tried, so a later read may try again. */
export class GrantReadError extends Error {
    public constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : "The grant could not be read.", { cause });
        this.name = "GrantReadError";
    }
}
