import type { betterAuth } from "better-auth";
import type {
    anonymousClient,
    emailOTPClient,
    magicLinkClient,
    multiSessionClient,
    oneTapClient,
    organizationClient,
    twoFactorClient,
    usernameClient,
} from "better-auth/client/plugins";
import type { BetterFetchOption, BetterFetchResponse, createAuthClient } from "better-auth/react";

import type { AuthClient } from "@/lib/auth/client";

import type { ApiKey, Passkey } from "./data-structure-types";

// NOTE: there is no `ApiKeyClientPlugin` here. better-auth moved the api-key plugin out of
// core into the separate `@better-auth/api-key` package, which this app does not depend on,
// and `authClient` (src/lib/auth/client.ts) does not register it. The api-key hooks under
// `hooks/api-key/` structurally cast the client instead.
export type MultiSessionClientPlugin = ReturnType<typeof multiSessionClient>;
export type OneTapClientPlugin = ReturnType<typeof oneTapClient>;
export type AnonymousClientPlugin = ReturnType<typeof anonymousClient>;
export type UsernameClientPlugin = ReturnType<typeof usernameClient>;
export type MagicLinkClientPlugin = ReturnType<typeof magicLinkClient>;
export type EmailOTPClientPlugin = ReturnType<typeof emailOTPClient>;
export type TwoFactorClientPlugin = ReturnType<typeof twoFactorClient>;
export type OrganizationClientPlugin = ReturnType<typeof organizationClient>;

export type Session = AuthClient["$Infer"]["Session"]["session"];
export type User = AuthClient["$Infer"]["Session"]["user"];

/**
 * The structural minimum every auth hook accepts: a client with NO plugins registered.
 *
 * Members whose signature widens with the registered plugin set have to be omitted, or
 * the concrete plugin-rich `authClient` stops being assignable to this. `signUp` and
 * `getSession` were always in that set; `hydrateSession` joined it in better-auth
 * 1.7.0-rc.2. It takes the session as a parameter, so it is CONTRAVARIANT — the
 * plugin-rich client only accepts a session carrying `isAnonymous`/`banned`/
 * `twoFactorEnabled`, which the plugin-less signature does not promise to supply, and
 * the assignment is correctly rejected. Every hook here is passed the real client, so
 * omitting the member is sound; nothing reads `hydrateSession` through this type.
 */
export type AnyAuthClient = Omit<ReturnType<typeof createAuthClient>, "getSession" | "hydrateSession" | "signUp">;

export type BetterAuth = ReturnType<typeof betterAuth>;

export type NonThrowableResult<T> = {
    data: T | null;
    error: Error | null;
};

export type ThrowableResult<T> = T;

/**
 * Call shape shared by every better-auth client action (`{ ...params, fetchOptions }` in,
 * a promise out). Used by the structural plugin shims below.
 */
export type AuthClientAction = (parameters: Record<string, unknown>) => Promise<unknown>;

/**
 * Read action. The parameter is optional so the same value satisfies both `useAuthQuery`
 * (`BetterFetchRequest`, called with `{ fetchOptions }`) and `useAuthData` (called with no args).
 */
export type AuthClientQueryAction<TData = unknown> = (parameters?: { fetchOptions: BetterFetchOption }) => Promise<BetterFetchResponse<TData>>;

/**
 * Structural shims for better-auth client plugins the `AuthClient` type does not
 * carry: `apiKey` and `multiSession` (not registered in `src/lib/auth/client.ts`)
 * and `passkey` (registered, but its client types are not threaded through here). The upstream `better-auth-ui` surface still references them, so the
 * call sites cast the client through these types instead of `any` — that keeps the argument
 * and return positions typed while making the missing-plugin boundary explicit.
 *
 * NOTE: these members are `undefined` at runtime until the matching client plugin is added,
 * so anything reached through them will throw when actually invoked.
 *
 * Each read action MUST carry its payload type argument. Left at the `unknown` default,
 * `useAuthQuery` infers `TData` as `{}` and every consumer of the query data has to cast.
 */
export type AuthClientWithApiKeyPlugin = {
    apiKey: {
        create: AuthClientAction;
        delete: AuthClientAction;
        list: AuthClientQueryAction<ApiKey[]>;
    };
};

export type AuthClientWithPasskeyPlugin = {
    passkey: {
        deletePasskey: AuthClientAction;
        listUserPasskeys: AuthClientQueryAction<Passkey[]>;
    };
    useListPasskeys: unknown;
};

export type AuthClientWithUsernamePlugin = {
    signIn: {
        username: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
};

export type AuthClientWithMultiSessionPlugin = {
    multiSession: {
        listDeviceSessions: AuthClientQueryAction<AuthClient["$Infer"]["Session"][]>;
        revoke: AuthClientAction;
        setActive: AuthClientAction;
    };
};
