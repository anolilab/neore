import { createContext, use } from "react";

import type { GrantUser } from "./grant";

export type AuthStatus = "loading" | "signed-in" | "signed-out";

export interface AuthValue {
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
