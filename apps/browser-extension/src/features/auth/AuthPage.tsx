import LoginForm from "@neore/chat-ui/auth/login-form";
import { ExternalLinkIcon, LogInIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/lib/auth";
import { APP_URL, LLM_GATEWAY_URL, LUNORA_URL } from "@/lib/env";
import { signInWithWebAuthFlow } from "@/lib/extension-grant";
import { IS_FIREFOX } from "@/lib/target";

/** The backend and gateway host patterns, as `manifest.config.ts` declares them for the Firefox build. */
const hostOrigins = (): string[] =>
    [LUNORA_URL, LLM_GATEWAY_URL].flatMap((value) => {
        try {
            return value ? [`${new URL(value).origin}/*`] : [];
        } catch {
            return [];
        }
    });

/**
 * Firefox: one button. Sign-in happens on the web app in a window
 * `identity.launchWebAuthFlow` opens, so every method the app offers works
 * (password, Google, passkeys, 2FA) and no password is ever typed into the
 * extension — see `lib/extension-grant.ts`.
 */
function FirefoxAuthPage() {
    const [error, setError] = useState<string>();
    const [isSigningIn, setIsSigningIn] = useState(false);

    const signIn = () => {
        setError(undefined);
        setIsSigningIn(true);

        // MV3 host permissions can be withheld or revoked by the user in Firefox,
        // and without them the backend is not CORS-exempt. The request must start
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

    return (
        <main className="flex min-h-screen items-center justify-center p-4">
            <div className="flex w-full max-w-sm flex-col gap-4">
                <p className="text-center text-sm font-semibold text-gray-800 dark:text-gray-100">Anole Chat</p>
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
                    {isSigningIn ? "Waiting for sign-in…" : "Sign in"}
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

export function AuthPage() {
    if (IS_FIREFOX) {
        return <FirefoxAuthPage />;
    }

    return <CookieAuthPage />;
}

/**
 * Email + password signs in right here. Everything else — Google, magic link,
 * passkeys, accepting an invitation — happens on the web app in a normal tab:
 * the session cookie it sets on the app origin is the one this extension
 * already uses, so after that a session refetch is all it takes. (An OAuth
 * redirect cannot come back to a `chrome-extension://` page on its own.)
 *
 * The Chrome build.
 */
function CookieAuthPage() {
    const [error, setError] = useState<string>();
    const [openedWebSignIn, setOpenedWebSignIn] = useState(false);

    const openWebSignIn = () => {
        setOpenedWebSignIn(true);
        void chrome.tabs.create({ url: new URL("/auth/sign-in", APP_URL).href });
    };

    return (
        <main className="flex min-h-screen items-center justify-center p-4">
            <div className="flex w-full max-w-sm flex-col gap-4">
                <p className="text-center text-sm font-semibold text-gray-800 dark:text-gray-100">Anole Chat</p>
                <LoginForm
                    error={error}
                    onSignIn={async (email: string, password: string) => {
                        setError(undefined);

                        const result = await authClient.signIn.email({ email, password });

                        if (result.error) {
                            setError(result.error.message ?? "Sign-in failed.");
                        }
                    }}
                    onSignInWithGoogle={openWebSignIn}
                />
                <div className="flex flex-col gap-2 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
                    <button
                        className="flex items-center justify-center gap-1.5 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:border-gray-700 dark:hover:bg-gray-800"
                        onClick={openWebSignIn}
                        type="button"
                    >
                        <ExternalLinkIcon aria-hidden="true" className="size-4" />
                        Sign in on the web app
                    </button>
                    {openedWebSignIn && (
                        <button
                            className="flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800"
                            // Makes `useSession` refetch; the new cookie is on the app origin already.
                            onClick={() => authClient.$store.notify("$sessionSignal")}
                            type="button"
                        >
                            <RefreshCwIcon aria-hidden="true" className="size-4" />I have signed in
                        </button>
                    )}
                </div>
            </div>
        </main>
    );
}
