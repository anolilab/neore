"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import type { ErrorInfo, FC, ReactNode } from "react";
import { useEffect } from "react";

import { AuthenticationError, ErrorUtilities, NetworkError } from "@/lib/errors";

import { ErrorBoundary } from "../error-boundary";

interface RouteErrorBoundaryProperties {
    children: ReactNode;
    fallbackRoute?: string;
    routeName?: string;
}

/**
 * Stable, render-pure identifier for an error.
 *
 * `Date.now()` here would mint a different "Error ID" on every re-render of the
 * fallback, so the value a user reads out to support would never match the one
 * that was on screen a moment earlier. Hashing the error itself is pure, and it
 * has the useful side effect that the same failure always reports the same id.
 */
const hashError = (error: Error): string => {
    const input = `${error.name}:${error.message}`;
    let hash = 5381;

    for (let index = 0; index < input.length; index += 1) {
        hash = Math.imul(hash, 33) + input.codePointAt(index)!;
    }

    // `Math.imul(x, 1)` is the wrap-to-int32 the djb2 loop relies on.
    return Math.abs(Math.imul(hash, 1)).toString(36);
};

const ErrorContent: FC<{
    error: Error;
    handleGoBack: () => void;
    handleGoHome: () => void;
    handleReload: () => void;
    retry: () => void;
    routeName: string;
}> = ({ error, handleGoBack, handleGoHome, handleReload, retry, routeName }) => {
    const { i18n, t } = useLingui();
    const userMessage = ErrorUtilities.getUserMessage(error, i18n);
    const isAuth = error instanceof AuthenticationError;
    const isNetwork = error instanceof NetworkError;
    const errorId = `${routeName}_${hashError(error)}`;

    let title: string;
    let explanation: string;
    let primaryAction: ReactNode;

    if (isAuth) {
        title = t`Authentication Required`;
        explanation = t`You need to sign in to access this page.`;
    } else if (isNetwork) {
        title = t`Connection Problem`;
        explanation = t`There's a problem with your internet connection or our servers.`;
    } else {
        title = t`Error on ${routeName}`;
        explanation = t`An error occurred while loading the ${routeName} page.`;
    }

    if (isAuth) {
        primaryAction = (
            <Button className="w-full" onClick={() => globalThis.location.assign("/auth/signin")}>
                {t`Sign In`}
            </Button>
        );
    } else if (ErrorUtilities.isRetryable(error)) {
        primaryAction = (
            <Button className="w-full" onClick={retry}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t`Try Again`}
            </Button>
        );
    } else {
        primaryAction = (
            <Button className="w-full" onClick={handleReload}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t`Reload Page`}
            </Button>
        );
    }

    return (
        <div className="flex min-h-screen w-full items-center justify-center">
            <Card className="w-full max-w-lg">
                <CardHeader className="text-center">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
                        <AlertTriangle className="h-8 w-8 text-red-600 dark:text-red-400" />
                    </div>
                    <CardTitle className="text-xl">{title}</CardTitle>
                    <CardDescription className="text-base">{userMessage}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="bg-muted rounded-lg p-3 text-sm">
                        <p className="mb-1 text-center font-medium">{t`What happened?`}</p>
                        <p className="text-muted-foreground">{explanation}</p>
                    </div>

                    <div className="flex flex-col gap-2">
                        {primaryAction}

                        <div className="grid grid-cols-2 gap-2">
                            <Button onClick={handleGoBack} variant="outline">
                                <ArrowLeft className="mr-2 h-4 w-4" />
                                {t`Go Back`}
                            </Button>
                            <Button onClick={handleGoHome} variant="outline">
                                <Home className="mr-2 h-4 w-4" />
                                {t`Home`}
                            </Button>
                        </div>
                    </div>

                    <div className="text-muted-foreground space-y-1 text-center text-xs">
                        {isNetwork && (
                            <p>
                                💡
                                {t`Check your internet connection and try again.`}
                            </p>
                        )}
                        {isAuth && (
                            <p>
                                💡
                                {t`You'll be redirected back here after signing in.`}
                            </p>
                        )}
                        {!isNetwork && !isAuth && (
                            <p>
                                💡
                                {t`If this problem persists, please contact support.`}
                            </p>
                        )}
                        <p className="mt-2">
                            <Trans>
                                Error ID: <code className="bg-muted rounded px-1 text-xs">{errorId}</code>
                            </Trans>
                        </p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

const UnauthorizedThreadRedirect: FC = () => {
    useEffect(() => {
        if (globalThis.location.pathname !== "/chat") {
            globalThis.location.assign("/chat");
        }
    }, []);

    return null;
};

/**
 * Route-level error boundary for page-level error handling
 * Provides navigation recovery and route-specific error handling.
 */
const RouteErrorBoundary = ({ children, fallbackRoute = "/", routeName = "page" }: RouteErrorBoundaryProperties) => {
    const posthog = usePostHog();

    const handleError = (error: Error, errorInfo: ErrorInfo) => {
        if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.group(`🛣️ Route Error (${routeName})`);
            // eslint-disable-next-line no-console
            console.error("Error:", error);
            // eslint-disable-next-line no-console
            console.error("Error Info:", errorInfo);
            // eslint-disable-next-line no-console
            console.error("Route:", globalThis.location.pathname);
            // eslint-disable-next-line no-console
            console.error("Referrer:", document.referrer);
            // eslint-disable-next-line no-console
            console.groupEnd();
        }

        // Send error report with route context to PostHog
        if (posthog && typeof posthog.captureException === "function") {
            posthog.captureException(error, {
                componentStack: errorInfo.componentStack,
                errorBoundary: "route",
                errorType: error.constructor.name,
                feature: "route",
                referrer: document.referrer,
                route: globalThis.location.pathname,
                routeName,
                timestamp: new Date().toISOString(),
                url: globalThis.location.href,
                userAgent: navigator.userAgent,
            });
        }
    };

    const handleGoBack = () => {
        if (globalThis.history.length > 1) {
            globalThis.history.back();
        } else {
            globalThis.location.assign(fallbackRoute);
        }
    };

    const handleGoHome = () => {
        globalThis.location.assign(fallbackRoute);
    };

    const handleReload = () => {
        globalThis.location.reload();
    };

    const renderFallback = (error: Error) => {
        // Check if this is an UNAUTHORIZED error for thread access
        // cRPC/Lunora errors carry a structured `data` payload that is not on the base `Error`.
        const errorData = (error as Error & { data?: { code?: string } }).data;
        const isUnauthorizedThreadAccess =
            errorData?.code === "UNAUTHORIZED" && (error.message?.includes("Access denied to this thread") || error.message?.includes("thread"));

        // If it's a thread access error on a chat route, redirect to /chat
        if (isUnauthorizedThreadAccess && routeName.includes("chat")) {
            // Use a component to handle the redirect
            return <UnauthorizedThreadRedirect />;
        }

        return (
            <ErrorContent
                error={error}
                handleGoBack={handleGoBack}
                handleGoHome={handleGoHome}
                handleReload={handleReload}
                retry={handleReload}
                routeName={routeName}
            />
        );
    };

    return (
        <ErrorBoundary fallback={renderFallback} onError={handleError} showToast>
            {children}
        </ErrorBoundary>
    );
};

/**
 * Component that redirects to /chat when thread access is unauthorized.
 */
export default RouteErrorBoundary;
