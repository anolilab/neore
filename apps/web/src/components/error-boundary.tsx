"use client";

import { Trans } from "@lingui/react/macro";
import { PostHogErrorBoundary } from "@posthog/react";
import type { ErrorInfo, ReactNode } from "react";
import React from "react";

import { UserErrorMessage } from "@/lib/localized-message";
import { showError } from "@/lib/toast";

interface ErrorBoundaryProperties {
    children: ReactNode;
    fallback?: (error: Error) => ReactNode;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    showToast?: boolean;
}

/**
 * Simple Error Boundary wrapper around PostHogErrorBoundary
 * Automatically logs errors to PostHog.
 */
export const ErrorBoundary = ({ children, fallback, onError, showToast }: ErrorBoundaryProperties) => {
    const defaultFallback = ({ componentStack, error }: { componentStack?: string; error: unknown; exceptionEvent?: any }) => {
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

    return <PostHogErrorBoundary fallback={defaultFallback}>{children}</PostHogErrorBoundary>;
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
