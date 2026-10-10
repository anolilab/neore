import type { Invitation } from "better-auth/plugins/organization";
import type { BetterFetchError } from "better-auth/react";

import type { AuthClient } from "@/lib/auth/client";

import type { AnyAuthClient } from "./auth-core-types";
import type { ApiKey, Passkey } from "./data-structure-types";

// Refetch Function Type (from refetch.ts)
export type Refetch = () => Promise<unknown> | unknown;

// Toast Rendering Types (from render-toast.ts)
type ToastVariant = "default" | "success" | "error" | "info" | "warning";

export type RenderToast = ({ message, variant }: { message?: string; variant?: ToastVariant }) => void;

// Auth Mutators Types (from auth-mutators.ts)
type MutateFunction<T = Record<string, unknown>> = (parameters: T) => Promise<unknown> | Promise<void>;

export interface AuthMutators {
    deleteApiKey: MutateFunction<{ keyId: string }>;
    deletePasskey: MutateFunction<{ id: string }>;
    revokeDeviceSession: MutateFunction<{ sessionToken: string }>;
    revokeSession: MutateFunction<{ token: string }>;
    setActiveSession: MutateFunction<{ sessionToken: string }>;
    // better-auth 1.7 reduced `/unlink-account` to `{ accountId }`, required, matched
    // against the account row's `id` — NOT the provider's account id, and `providerId`
    // is no longer accepted at all.
    unlinkAccount: MutateFunction<{ accountId: string }>;
    updateUser: MutateFunction;
}

// Auth Hooks Types (from auth-hooks.ts)
type AnyAuthSession = AnyAuthClient["$Infer"]["Session"];

type AuthHook<T> = {
    data?: T | null;
    error?: BetterFetchError | null;
    isPending: boolean;
    refetch?: Refetch;
};

export type AuthHooks = {
    useActiveOrganization: () => Partial<ReturnType<AuthClient["useActiveOrganization"]>>;
    useHasPermission: (parameters: Parameters<AuthClient["organization"]["hasPermission"]>[0]) => AuthHook<{
        error: null;
        success: boolean;
    }>;
    // `/organization/get-invitation` spreads the invitation row and adds exactly three
    // fields. There is no `organizationLogo` — the endpoint never returns one, so nothing
    // may render an organization logo from an invitation.
    useInvitation: (parameters: Parameters<AuthClient["organization"]["getInvitation"]>[0]) => AuthHook<
        Invitation & {
            inviterEmail: string;
            organizationName: string;
            organizationSlug: string;
        }
    >;
    useIsRestoring?: () => boolean;
    // `/list-accounts` spreads the account row, so the fields are `id` and `providerId`.
    // This was declared as `{ accountId, provider }` — `useAuthData` does not infer from
    // its `queryFn`, so the wrong shape never failed to compile, and every consumer
    // matching on `.provider` silently found nothing.
    useListAccounts: () => AuthHook<{ id: string; providerId: string }[]>;
    useListApiKeys: () => AuthHook<ApiKey[]>;
    useListDeviceSessions: () => AuthHook<AuthClient["$Infer"]["Session"][]>;
    useListOrganizations: () => Partial<ReturnType<AuthClient["useListOrganizations"]>>;
    useListPasskeys: () => AuthHook<Passkey[]>;
    useListSessions: () => AuthHook<AnyAuthSession["session"][]>;
    useSession: () => ReturnType<AuthClient["useSession"]>;
};
