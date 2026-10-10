import type { ComponentType, ReactNode } from "react";

// API Key Data Structure (from api-key.ts)
export type ApiKey = {
    createdAt: Date;
    expiresAt?: Date;
    id: string;
    /** When the key last authenticated a request (`/api-key/list`'s `lastRequest`). */
    lastRequest?: Date | string | null;
    name: string;
    /** better-auth's `{ resource: action[] }` statement — the key's public-API scopes. */
    permissions?: Record<string, string[]> | null;
    start: string;
    updatedAt: Date;
};

// Passkey Data Structure. Mirrors the `passkey` row `GET /passkey/list-user-passkeys`
// returns. Declared here rather than imported from `@better-auth/passkey` because that
// package is not a dependency of this app (see the note in `auth-core-types.ts`).
export type Passkey = {
    aaguid?: string;
    backedUp: boolean;
    counter: number;
    createdAt: Date;
    credentialID: string;
    deviceType: string;
    id: string;
    name?: string;
    publicKey: string;
    transports?: string;
    userId: string;
};

// User Profile Data Structure (from profile.ts)
export type Profile = {
    avatar?: string | null;
    avatarUrl?: string | null;
    displayName?: string | null;
    displayUsername?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    firstName?: string | null;
    fullName?: string | null;
    id?: string | number;
    image?: string | null;
    isAnonymous?: boolean | null;
    name?: string | null;
    username?: string | null;
};

// Account Listing Data Structure (from list-account.ts)
export type ListAccount = {
    accountId: string;
    createdAt: Date;
    id: string;
    provider: string;
    scopes: string[];
    updatedAt: Date;
};

// Fetch Error Data Structure (from fetch-error.ts)
export type FetchError = {
    code?: string;
    message?: string;
    status?: number;
    statusText?: string;
};

// Link Component Type (from link.ts)
export type Link = ComponentType<{
    children: ReactNode;
    className?: string;
    href: string;
}>;
