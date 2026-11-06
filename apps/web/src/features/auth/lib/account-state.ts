/** The slice of a session read (`hooks.useSession()`) that says whether there is an account behind it. */
export interface SessionRead {
    data?: { user?: { isAnonymous?: boolean | null } | null } | null;
    error?: unknown;
    isPending?: boolean;
}

/**
 * Whether the visitor has no account: a guest, or a session read that ANSWERED with no user. A read still pending,
 * or one that failed, is unknown, not signed out (`features/auth/AGENTS.md`), so it locks nothing.
 */
export const hasNoAccount = ({ data, error, isPending }: SessionRead): boolean => {
    const user = data?.user;

    if (user) {
        return user.isAnonymous === true;
    }

    return !isPending && (error === null || error === undefined);
};
