import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import type { Provider } from "../lib/social-providers";
import socialProviders from "../lib/social-providers";

/**
 * The sign-in methods this deployment offers — `GET /api/auth/sign-in-methods`
 * (`backend/lunora/auth/sign-in-methods.ts`). Every provider beyond email is
 * optional and configured on the backend, so the buttons come from there rather
 * than from a build-time list that could offer a provider the backend lacks.
 */
export interface SignInMethods {
    /** Registration needs an invitation, and guests are refused (`SIGNUP_INVITE_ONLY`). */
    inviteOnly: boolean;
    oidc: { label: string; providerId: string } | null;
    passkey: boolean;
    social: string[];
}

/** How long an answer is used before it is read again. */
export const SIGN_IN_METHODS_STALE_MS = 5 * 60 * 1000;

const NO_METHODS: SignInMethods = { inviteOnly: true, oidc: null, passkey: false, social: [] };

const isSignInMethods = (value: unknown): value is SignInMethods => {
    const candidate = value as Partial<SignInMethods> | null;

    return typeof candidate?.passkey === "boolean" && Array.isArray(candidate.social);
};

const fetchSignInMethods = async (): Promise<SignInMethods> => {
    // Same-origin: the app proxies `/api/auth/*` to the backend.
    const response = await fetch("/api/auth/sign-in-methods", { credentials: "omit", headers: { accept: "application/json" } });

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(`sign-in-methods: ${response.status}`);
    }

    const body: unknown = await response.json();

    if (!isSignInMethods(body)) {
        return NO_METHODS;
    }

    // A backend that does not say is treated as invite-only: the failure direction of "open" is guests and sign-up links.
    return { ...body, inviteOnly: body.inviteOnly !== false };
};

/**
 * What to render: the social provider ids (the OIDC provider among them — it
 * signs in through the same `signIn.social`), whether passkeys are on, and a
 * resolver from provider id to its button config.
 *
 * Only queried where sign-in UI renders, and at most once per five minutes. Until
 * it answers (and during SSR) nothing but email is offered, which is also the
 * safe reading when the backend is unreachable.
 *
 * `inviteOnly` is `undefined` until the answer arrives (and during SSR), so a
 * caller can wait rather than guess; after a failed fetch it reads `true`.
 */
const useSignInMethods = (): {
    findProvider: (id: string) => Provider | undefined;
    inviteOnly: boolean | undefined;
    isLoading: boolean;
    passkey: boolean;
    socialProviders: string[];
} => {
    const {
        data = NO_METHODS,
        isError,
        isLoading,
        isSuccess,
    } = useQuery({
        enabled: globalThis.window !== undefined,
        queryFn: fetchSignInMethods,
        queryKey: ["auth", "sign-in-methods"],
        retry: 1,
        // As long as the endpoint's own `cache-control` (5 min), so a policy change (`SIGNUP_INVITE_ONLY`) reaches an
        // open tab at its next mount or focus instead of only after a reload.
        staleTime: SIGN_IN_METHODS_STALE_MS,
    });

    const { oidc } = data;

    return {
        findProvider: (id) => {
            if (oidc && id === oidc.providerId) {
                return { icon: KeyRound, name: oidc.label, provider: oidc.providerId };
            }

            return socialProviders.find((candidate) => candidate.provider === id);
        },
        inviteOnly: isSuccess || isError ? data.inviteOnly : undefined,
        isLoading,
        passkey: data.passkey,
        socialProviders: oidc ? [...data.social, oidc.providerId] : data.social,
    };
};

export default useSignInMethods;
