import { LogInIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { LLM_GATEWAY_URL, LUNORA_URL } from "@/lib/env";
import { readReconnectNeeded, signInWithWebAuthFlow } from "@/lib/extension-grant";

/** The backend and gateway host patterns, as `manifest.config.ts` declares them. */
const hostOrigins = (): string[] =>
    [LUNORA_URL, LLM_GATEWAY_URL].flatMap((value) => {
        try {
            return value ? [`${new URL(value).origin}/*`] : [];
        } catch {
            return [];
        }
    });

/**
 * One button, in both builds. Sign-in happens on the web app in a window
 * `identity.launchWebAuthFlow` opens, so every method the app offers works
 * (password, Google, passkeys, 2FA) and no password is ever typed into the
 * extension — see `lib/extension-grant.ts`.
 *
 * A Chrome install that used to share the web app's cookie lands here once
 * after the update, and is told why (`migrateFromCookieSession`).
 */
export function AuthPage() {
    const [error, setError] = useState<string>();
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [reconnect, setReconnect] = useState(false);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            const needed = await readReconnectNeeded();

            if (!cancelled) {
                setReconnect(needed);
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    const signIn = () => {
        setError(undefined);
        setIsSigningIn(true);

        // MV3 host permissions can be withheld or revoked by the user (Firefox, and
        // Chrome's site access), and without them the backend is not CORS-exempt. The request must start
        // synchronously in the click handler; it resolves at once when granted.
        const permission = chrome.permissions.request({ origins: hostOrigins() });

        const run = async () => {
            try {
                if (!(await permission)) {
                    setError("Anole needs access to its own servers to sign in.");

                    return;
                }

                // Success is observed through storage: the session hook re-renders the panel.
                await signInWithWebAuthFlow();
            } catch (signInError: unknown) {
                setError(signInError instanceof Error ? signInError.message : "Sign-in failed.");
            } finally {
                setIsSigningIn(false);
            }
        };

        void run();
    };

    const idleLabel = reconnect ? "Connect" : "Sign in";

    return (
        <main className="flex min-h-screen items-center justify-center p-4">
            <div className="flex w-full max-w-sm flex-col gap-4">
                <p className="text-center text-sm font-semibold text-gray-800 dark:text-gray-100">Anole Chat</p>
                {reconnect && (
                    <p className="rounded-md bg-gray-100 p-2 text-center text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100" role="status">
                        Anole Chat has a new way to sign in. Connect your account once to keep chatting.
                    </p>
                )}
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                    Sign in with your Anole account. A window opens where you sign in and approve this extension.
                </p>
                <button
                    className="flex items-center justify-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                    disabled={isSigningIn}
                    onClick={signIn}
                    type="button"
                >
                    <LogInIcon aria-hidden="true" className="size-4" />
                    {isSigningIn ? "Waiting for sign-in…" : idleLabel}
                </button>
                {error && (
                    <p className="text-center text-sm text-red-600 dark:text-red-400" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </main>
    );
}
