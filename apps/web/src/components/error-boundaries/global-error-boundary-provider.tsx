"use client";

import { Trans } from "@lingui/react/macro";
import { usePostHog } from "posthog-js/react";
import type { ErrorInfo, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { ErrorUtilities } from "@/lib/errors";
import { UserErrorMessage } from "@/lib/localized-message";
import { networkToast, showError } from "@/lib/toast";

import { ErrorBoundary } from "../error-boundary";

interface GlobalErrorBoundaryProviderProperties {
    children: ReactNode;
}

const GlobalErrorBoundaryProvider = ({ children }: GlobalErrorBoundaryProviderProperties) => {
    const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
    // Identifies the error occurrence for support. Minted when the boundary
    // catches, not while rendering the fallback — `Date.now()` in render would
    // hand out a different id on every re-paint of the same crash.
    const [errorId, setErrorId] = useState<string | null>(null);
    const posthog = usePostHog();

    // Monitor network status
    useEffect(() => {
        const handleOnline = () => {
            setIsOnline(true);
            networkToast.online();
        };

        const handleOffline = () => {
            setIsOnline(false);
            networkToast.offline();
        };

        globalThis.addEventListener("online", handleOnline);
        globalThis.addEventListener("offline", handleOffline);

        return () => {
            globalThis.removeEventListener("online", handleOnline);
            globalThis.removeEventListener("offline", handleOffline);
        };
    }, []);

    // Global unhandled promise rejection handler
    useEffect(() => {
        const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
            // A superseded view transition is not an error.
            //
            // With the router's `defaultViewTransition` on, every navigation
            // that interrupts an in-flight transition rejects with
            // `AbortError: Transition was skipped` — the browser reporting that
            // it did the right thing. Treated as a failure it becomes an error
            // toast in the user's face and a PostHog `$exception`, ~150 of each
            // in one short session, which buries the reports that matter.
            const { reason } = event;

            if (reason instanceof Error && reason.name === "AbortError" && reason.message === "Transition was skipped") {
                event.preventDefault();

                return;
            }

            console.error("Unhandled promise rejection:", event.reason);

            // Convert to proper error
            const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));

            // Show user-friendly error
            showError(error);

            // Send error to PostHog
            if (posthog && typeof posthog.captureException === "function") {
                posthog.captureException(error, {
                    errorType: "unhandled-promise-rejection",
                    isOnline,
                    timestamp: new Date().toISOString(),
                    url: globalThis.location.href,
                    userAgent: navigator.userAgent,
                });
            }

            // Prevent default browser error handling
            event.preventDefault();
        };

        globalThis.addEventListener("unhandledrejection", handleUnhandledRejection);

        return () => {
            globalThis.removeEventListener("unhandledrejection", handleUnhandledRejection);
        };
    }, [posthog, isOnline]);

    // Global error handler for JavaScript errors
    useEffect(() => {
        const handleError = (event: ErrorEvent) => {
            // Ignore ResizeObserver warnings - these are harmless browser warnings, not real errors
            // This is a known browser issue: https://github.com/WICG/resize-observer/issues/38
            if (event.message?.includes("ResizeObserver loop completed with undelivered notifications")) {
                return;
            }

            // Handle null/undefined errors gracefully (often from aborted requests or network issues)
            if (event.error === null || event.error === undefined) {
                return;
            }

            console.error("Global JavaScript error:", event.error);

            const error = event.error instanceof Error ? event.error : new Error(event.message || "Unknown error");

            // Show user-friendly error
            showError(error);

            // Send error to PostHog
            if (posthog && typeof posthog.captureException === "function") {
                posthog.captureException(error, {
                    colno: event.colno,
                    errorType: "javascript-error",
                    filename: event.filename,
                    isOnline,
                    lineno: event.lineno,
                    timestamp: new Date().toISOString(),
                    url: globalThis.location.href,
                    userAgent: navigator.userAgent,
                });
            }
        };

        globalThis.addEventListener("error", handleError);

        return () => {
            globalThis.removeEventListener("error", handleError);
        };
    }, [posthog, isOnline]);

    const getLocalStorageSnapshot = useCallback(() => {
        try {
            const snapshot: Record<string, string | null> = {};

            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);

                if (key && !key.includes("password") && !key.includes("token")) {
                    snapshot[key] = localStorage.getItem(key);
                }
            }

            return snapshot;
        } catch {
            return {};
        }
    }, []);

    const getSessionStorageSnapshot = useCallback(() => {
        try {
            const snapshot: Record<string, string | null> = {};

            for (let index = 0; index < sessionStorage.length; index += 1) {
                const key = sessionStorage.key(index);

                if (key && !key.includes("password") && !key.includes("token")) {
                    snapshot[key] = sessionStorage.getItem(key);
                }
            }

            return snapshot;
        } catch {
            return {};
        }
    }, []);

    const handleGlobalError = (error: Error, errorInfo: ErrorInfo) => {
        setErrorId(`global_${Date.now().toString(36)}`);

        console.group("🌍 Global Error Boundary");
        console.error("Error:", error);
        console.error("Error Info:", errorInfo);
        console.error("Online Status:", isOnline);
        console.groupEnd();

        // Send comprehensive error report to PostHog
        if (posthog && typeof posthog.captureException === "function") {
            posthog.captureException(error, {
                componentStack: errorInfo.componentStack,
                context: {
                    isOnline,
                    localStorage: getLocalStorageSnapshot(),
                    sessionStorage: getSessionStorageSnapshot(),
                    timestamp: new Date().toISOString(),
                    url: globalThis.location.href,
                    userAgent: navigator.userAgent,
                },
                errorBoundary: "global",
                errorType: "react-error-boundary",
            });
        }
    };

    const renderGlobalFallback = (error: Error) => {
        const displayErrorId = errorId ?? "…";
        const handleReload = () => {
            globalThis.location.reload();
        };

        return (
            <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-red-50 to-red-100 p-4 dark:from-red-950 dark:to-red-900">
                <div className="w-full max-w-md rounded-lg bg-white p-6 text-center shadow-xl dark:bg-gray-900">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
                        <svg className="h-8 w-8 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                            />
                        </svg>
                    </div>

                    <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-gray-100">
                        <Trans>Application Error</Trans>
                    </h1>

                    <p className="mb-6 text-gray-600 dark:text-gray-400">
                        <UserErrorMessage error={error} />
                    </p>

                    {!isOnline && (
                        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900">
                            <p className="text-sm text-yellow-800 dark:text-yellow-200">
                                <Trans>⚠️ You&apos;re currently offline. Some features may not work properly.</Trans>
                            </p>
                        </div>
                    )}

                    <div className="space-y-3">
                        {ErrorUtilities.isRetryable(error) && (
                            <button
                                className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
                                onClick={handleReload}
                                type="button"
                            >
                                <Trans>Try Again</Trans>
                            </button>
                        )}

                        <button
                            className="w-full rounded-lg bg-gray-600 px-4 py-2 font-medium text-white hover:bg-gray-700"
                            onClick={handleReload}
                            type="button"
                        >
                            <Trans>Reload Application</Trans>
                        </button>

                        <button
                            className="w-full rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                            onClick={() => globalThis.location.assign("/")}
                            type="button"
                        >
                            <Trans>Go to Home</Trans>
                        </button>
                    </div>

                    <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
                        <p>
                            <Trans>If this problem persists, please contact support.</Trans>
                        </p>
                        <p className="mt-1">
                            <Trans>
                                Error ID: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{displayErrorId}</code>
                            </Trans>
                        </p>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <ErrorBoundary
            fallback={renderGlobalFallback}
            onError={handleGlobalError}
            showToast={false} // We handle our own notifications
        >
            {children}
        </ErrorBoundary>
    );
};

export default GlobalErrorBoundaryProvider;
