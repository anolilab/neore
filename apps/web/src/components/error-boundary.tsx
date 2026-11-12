"use client";

import { Trans } from "@lingui/react/macro";
import type { ErrorInfo, ReactNode } from "react";
import React from "react";

import { getPostHog } from "@/lib/analytics/posthog-client";
import { UserErrorMessage } from "@/lib/localized-message";
import { showError } from "@/lib/toast";

interface ErrorBoundaryProperties {
    children: ReactNode;
    fallback?: (error: Error) => ReactNode;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    showToast?: boolean;
}

interface CapturedError {
    componentStack: string;
    error: unknown;
}

/**
 * Hands React's component stack to PostHog as the error's innermost `cause`, named `React ErrorBoundary <name>`, as
 * `@posthog/react`'s boundary does, so the exception groups as it did before this boundary replaced that one.
 */
const withComponentStack = (error: unknown, componentStack: string): unknown => {
    if (!componentStack) {
        return error;
    }

    const stackError = new Error(error instanceof Error ? error.message : `Primitive value captured as exception: ${String(error)}`);

    // Defined, not assigned: the same shape `@posthog/react` builds, without writing to a built-in error's fields.
    Object.defineProperties(stackError, {
        name: {
            configurable: true,
            value: `React ErrorBoundary ${error instanceof Error ? error.name : "Error"}`,
            writable: true,
        },
        stack: { configurable: true, value: componentStack, writable: true },
    });

    if (!(error instanceof Error)) {
        return stackError;
    }

    const seen = new Set<Error>();
    let current: Error = error;

    while (!seen.has(current)) {
        seen.add(current);

        if (!(current.cause instanceof Error)) {
            if (current.cause !== undefined) {
                Object.defineProperty(stackError, "cause", { configurable: true, value: current.cause, writable: true });
            }

            Object.defineProperty(current, "cause", { configurable: true, value: stackError, writable: true });

            return error;
        }

        current = current.cause;
    }

    return error;
};

/**
 * Catches a render error, reports it to PostHog (once PostHog has loaded; `lib/analytics/posthog-client.ts`) and
 * renders `fallback` in its place. Kept free of `@posthog/react`, which would put `posthog-js` on the first load.
 */
class PostHogCapturingBoundary extends React.Component<
    { children: ReactNode; fallback: (captured: CapturedError) => ReactNode },
    { captured: CapturedError | null }
> {
    public override state: { captured: CapturedError | null } = { captured: null };

    public override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
        const componentStack = errorInfo.componentStack ?? "";

        getPostHog()?.captureException(withComponentStack(error, componentStack));
        this.setState({ captured: { componentStack, error } });
    }

    public override render(): ReactNode {
        const { children, fallback } = this.props;
        const { captured } = this.state;

        return captured ? fallback(captured) : children;
    }
}

/**
 * Error boundary that reports what it catches to PostHog.
 */
export const ErrorBoundary = ({ children, fallback, onError, showToast }: ErrorBoundaryProperties) => {
    const defaultFallback = ({ componentStack, error }: CapturedError) => {
        // Convert unknown error to Error
        const errorObject = error instanceof Error ? error : new Error(String(error));

        // Call custom error handler if provided
        if (onError) {
            const errorInfo: ErrorInfo = {
                componentStack: componentStack || "",
            };

            onError(errorObject, errorInfo);
        }

        // Show toast notification if enabled
        if (showToast !== false) {
            showError(errorObject);
        }

        // Use custom fallback if provided
        if (fallback) {
            return fallback(errorObject);
        }

        // Default fallback: show error message
        return (
            <div className="flex min-h-screen items-center justify-center p-4">
                <div className="border-destructive/20 bg-destructive/5 w-full max-w-md rounded-lg border p-6">
                    <h2 className="text-destructive text-lg font-semibold">
                        <Trans>Something went wrong</Trans>
                    </h2>
                    <p className="text-muted-foreground mt-2 text-sm">
                        <UserErrorMessage error={errorObject} />
                    </p>
                    <button
                        className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 rounded-md px-4 py-2 text-sm"
                        onClick={() => {
                            if (globalThis.window !== undefined) {
                                globalThis.location.reload();
                            }
                        }}
                        type="button"
                    >
                        <Trans>Reload Page</Trans>
                    </button>
                </div>
            </div>
        );
    };

    return <PostHogCapturingBoundary fallback={defaultFallback}>{children}</PostHogCapturingBoundary>;
};

/**
 * Higher-order component for wrapping components with error boundaries.
 */
export const withErrorBoundary = <P extends object>(Component: React.ComponentType<P>, errorBoundaryProperties?: Omit<ErrorBoundaryProperties, "children">) => {
    const WrappedComponent = (properties: P) => (
        <ErrorBoundary {...errorBoundaryProperties}>
            <Component {...properties} />
        </ErrorBoundary>
    );

    WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`;

    return WrappedComponent;
};

/**
 * Hook for manually triggering error boundaries (useful for async errors).
 */
export const useErrorHandler = () => {
    const [error, setError] = React.useState<Error | null>(null);

    const handleError = (nextError: Error) => {
        setError(nextError);
    };

    React.useEffect(() => {
        if (error) {
            throw error;
        }
    }, [error]);

    return handleError;
};
