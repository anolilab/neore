import { createContext, use } from "react";

import type { GrantUser } from "./grant";

export type AuthStatus = "loading" | "signed-in" | "signed-out";

export interface AuthValue {
    /** Whether a JWT is held. A cold start with no network is signed in (the stored user is known) but holds none, so it reads nothing from the server. */
    hasToken: boolean;
    /** Mints a new JWT now instead of at the next retry. */
    retryToken: () => void;
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
    status: AuthStatus;
    user: GrantUser | null;
}

/** Provided by `AuthProvider`. Kept apart from the provider so the component module exports only components. */
export const AuthContext = createContext<AuthValue | undefined>(undefined);

export const useAuth = (): AuthValue => {
    const value = use(AuthContext);

    if (!value) {
        throw new Error("useAuth must be used inside AuthProvider");
    }

    return value;
};
