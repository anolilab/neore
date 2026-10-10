import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import useAuthenticate from "@/features/auth/hooks/use-authenticate";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import getSessionToken from "@/lib/auth/server-functions";
import env from "@/lib/env";
import { seo } from "@/lib/seo";

/**
 * Approve a browser extension that cannot share this site's cookies (the Firefox
 * build) — step 2 of the PKCE flow in `backend/lunora/auth/extension-grant.ts`.
 *
 * The extension opens this page inside `identity.launchWebAuthFlow`. The user
 * signs in the normal way (`useAuthenticate` bounces to sign-in and back), then
 * approves; the backend mints a one-time code bound to this user, the
 * extension's PKCE challenge and its redirect URI, and this page navigates to
 * that URI. The browser intercepts the navigation and hands it to the extension
 * without loading it.
 *
 * The redirect URI is validated by the BACKEND against
 * `TRUSTED_EXTENSION_REDIRECT_URIS` before any code exists, and this page only
 * ever navigates to it with a code the backend issued for it — so it cannot be
 * used as an open redirect. Declining just closes the window.
 */
interface ExtensionAuthSearch {
    code_challenge?: string;
    redirect_uri?: string;
    state?: string;
}

/**
 * The native shell's callback (`NATIVE_REDIRECT_URI` in
 * `backend/lunora/lib/extension-origins.ts`). The copy follows the redirect URI
 * — where the code will actually go — not any `client` hint in the link.
 */
const NATIVE_REDIRECT_URI = "neore://auth/callback";

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const ExtensionAuthorize = () => {
    const { t } = useLingui();
    const search = Route.useSearch();
    const { data, isPending } = useAuthenticate();
    const { isAnonymous } = useIsAnonymous();
    const [error, setError] = useState<string>();
    const [isApproving, setIsApproving] = useState(false);
    const [isDone, setIsDone] = useState(false);

    const { code_challenge: codeChallenge, redirect_uri: redirectUri, state } = search;

    if (!codeChallenge || !redirectUri || !state) {
        return (
            <p className="text-center text-sm text-red-600" role="alert">
                {t`This sign-in link is incomplete. Start signing in from the extension again.`}
            </p>
        );
    }

    if (isPending || !data?.user) {
        return (
            <p className="text-center text-sm text-gray-600" role="status">
                {t`Loading…`}
            </p>
        );
    }

    if (isAnonymous) {
        const here = globalThis.location.href.replace(globalThis.location.origin, "");

        return (
            <div className="flex flex-col gap-4 text-center">
                <p className="text-sm text-gray-700">{t`You are browsing as a guest. Sign in with your account to connect the extension.`}</p>
                <a className="text-sm font-medium underline underline-offset-4" href={`/auth/sign-in?redirectTo=${encodeURIComponent(here)}`}>
                    {t`Sign in`}
                </a>
            </div>
        );
    }

    const isNativeApp = redirectUri === NATIVE_REDIRECT_URI;

    if (isDone) {
        return (
            <p className="text-center text-sm text-gray-700" role="status">
                {isNativeApp ? t`Signed in. Return to the Neore app — you can close this tab.` : t`Connected. You can close this window.`}
            </p>
        );
    }

    const approve = async () => {
        setError(undefined);
        setIsApproving(true);

        try {
            const token = await getSessionToken();

            if (!token) {
                throw new Error(t`Your session has expired. Reload the page and sign in again.`);
            }

            const response = await fetch(new URL("/extension/auth/authorize", env.VITE_LUNORA_URL), {
                body: JSON.stringify({ codeChallenge, redirectUri }),
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                method: "POST",
            });
            const body = (await response.json().catch(() => {
                return {};
            })) as { code?: string; message?: string };

            if (!response.ok || !body.code) {
                throw new Error(body.message ?? t`The extension could not be connected.`);
            }

            const target = new URL(redirectUri);

            target.searchParams.set("code", body.code);
            target.searchParams.set("state", state);
            setIsDone(true);
            globalThis.location.replace(target.href);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : t`The extension could not be connected.`);
            setIsApproving(false);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <h1 className="text-center text-xl font-semibold">{isNativeApp ? t`Sign in to the Neore desktop app` : t`Connect the Anole browser extension`}</h1>
            <p className="text-center text-sm text-gray-700">
                {isNativeApp
                    ? t`The Neore app on this device will be signed in as ${data.user.email}. Only continue if you started signing in from the app just now.`
                    : t`The extension will be able to read and send chats as ${data.user.email}. You can disconnect it at any time by signing out in the extension or ending its session in your account settings.`}
            </p>
            {error && (
                <p className="text-center text-sm text-red-600" role="alert">
                    {error}
                </p>
            )}
            <div className="flex justify-center gap-2">
                <Button disabled={isApproving} onClick={() => globalThis.close()} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button
                    disabled={isApproving}
                    onClick={() => {
                        approve().catch(() => undefined);
                    }}
                    type="button"
                >
                    {isApproving ? t`Connecting…` : t`Connect`}
                </Button>
            </div>
        </div>
    );
};

export const Route = createFileRoute("/auth/extension")({
    component: ExtensionAuthorize,
    validateSearch: (search: Record<string, unknown>): ExtensionAuthSearch => {
        return {
            code_challenge: asString(search.code_challenge),
            redirect_uri: asString(search.redirect_uri),
            state: asString(search.state),
        };
    },
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Connect extension`) }),
        };
    },
});
