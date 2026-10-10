import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import type { MouseEvent, ReactNode } from "react";
import { createElement } from "react";
import { toast } from "sonner";

import { ErrorUtilities, RateLimitError } from "./errors";
import { LocalizedMessage, UserErrorMessage } from "./localized-message";

/**
 * These helpers run outside any component, where `useLingui()` is not
 * available, so their own copy renders as an element that translates itself
 * inside the toaster (which sits under the app's `I18nProvider`).
 */
const localized = (message: MessageDescriptor): ReactNode => createElement(LocalizedMessage, { message });

type ToastMessage = (() => ReactNode) | ReactNode;

export interface ToastOptions {
    action?: {
        label: ReactNode;
        onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    };
    cancel?: {
        label: ReactNode;
        onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    };
    duration?: number;
    id?: string | number;
}

/**
 * Show success toast.
 */
export const showSuccess = (message: ToastMessage | ReactNode, options?: ToastOptions) =>
    toast.success(message, {
        action: options?.action,
        cancel: options?.cancel,
        duration: options?.duration || 4000,
        id: options?.id,
    });

/**
 * Show info toast.
 */
export const showInfo = (message: ToastMessage | ReactNode, options?: ToastOptions) =>
    toast.info(message, {
        action: options?.action,
        cancel: options?.cancel,
        duration: options?.duration || 4000,
        id: options?.id,
    });

/**
 * Show error toast with appropriate styling and actions.
 */
export const showError = (error: Error | ReactNode, options?: ToastOptions) => {
    const message = error instanceof Error ? createElement(UserErrorMessage, { error }) : error;

    const toastOptions: any = {
        action: options?.action,
        cancel: options?.cancel,
        duration: options?.duration || 6000,
        id: options?.id,
    };

    // Add retry action for retryable errors
    if (error instanceof Error && ErrorUtilities.isRetryable(error) && !toastOptions.action && options?.action) {
        toastOptions.action = {
            label: localized(msg`Retry`),
            onClick: options.action.onClick,
        };
    }

    // Special handling for rate limit errors
    if (error instanceof RateLimitError) {
        const retryAfterMinutes = error.getRetryAfterMinutes();

        toastOptions.duration = 8000; // Longer duration for rate limit messages

        if (!toastOptions.action) {
            toastOptions.action = {
                label: localized(msg`Retry in ${retryAfterMinutes}m`),
                onClick: () => {
                    // Schedule a retry notification
                    setTimeout(() => {
                        showInfo(localized(msg`You can try again now!`), { duration: 3000 });
                    }, error.retryAfter);
                },
            };
        }
    }

    return toast.error(message, toastOptions);
};

/**
 * Show warning toast.
 */
export const showWarning = (message: ToastMessage | ReactNode, options?: ToastOptions) =>
    toast.warning(message, {
        action: options?.action,
        cancel: options?.cancel,
        duration: options?.duration || 5000,
        id: options?.id,
    });

/**
 * Show loading toast.
 */
export const showLoading = (message: ToastMessage | ReactNode, options?: Omit<ToastOptions, "duration">) =>
    toast.loading(message, {
        action: options?.action,
        cancel: options?.cancel,
        id: options?.id,
    });

/**
 * Dismiss a specific toast.
 */
export const dismissToast = (id: string | number) => {
    toast.dismiss(id);
};

/**
 * Clear every toast currently on screen, queued or visible.
 */
export const dismissAllToasts = () => {
    toast.dismiss();
};

/**
 * Promise-based toast for async operations.
 */
export const showPromiseToast = <T>(
    promise: Promise<T>,
    messages: {
        error: string | ((error: Error) => string);
        loading: string;
        success: string | ((data: T) => string);
    },
    options?: ToastOptions,
) =>
    toast.promise(promise, {
        action: options?.action,
        cancel: options?.cancel,
        duration: options?.duration,
        error: (error) => {
            const errorMessage = typeof messages.error === "function" ? messages.error(error) : createElement(UserErrorMessage, { error });

            return errorMessage;
        },
        id: options?.id,
        loading: messages.loading,
        success: (data) => (typeof messages.success === "function" ? messages.success(data) : messages.success),
    });

/**
 * Specialized toast for prompt improvement operations
 */
export const promptToast = {
    failed: (error: Error, retryFunction?: () => void, id?: string) => {
        if (id) {
            dismissToast(id);
        }

        return showError(error, {
            action:
                retryFunction && ErrorUtilities.isRetryable(error)
                    ? {
                          label: localized(msg`Retry`),
                          onClick: retryFunction,
                      }
                    : undefined,
        });
    },

    improved: (id?: string) => {
        if (id) {
            dismissToast(id);
        }

        return showSuccess(localized(msg`Prompt improved successfully!`));
    },

    improving: (id?: string) => showLoading(localized(msg`Improving your prompt...`), { id }),

    rateLimited: (error: RateLimitError) => {
        const minutes = error.getRetryAfterMinutes();

        return showWarning(
            localized(
                msg`Rate limit reached. You can improve ${plural(minutes, { one: "# more prompt", other: "# more prompts" })} in ${plural(minutes, { one: "# minute", other: "# minutes" })}.`,
            ),
            {
                action: {
                    label: localized(msg`Learn More`),
                    onClick: () => {
                        // Could open a modal or navigate to documentation
                        showInfo(localized(msg`Rate limits help ensure fair usage for all users.`));
                    },
                },
                duration: 8000,
            },
        );
    },

    validationError: (field: string, message: ToastMessage | ReactNode) => showError(`${field}: ${message}`, { duration: 5000 }),
};

/**
 * Network-related toasts
 */
export const networkToast = {
    offline: () =>
        showWarning(localized(msg`You're offline. Some features may not work.`), {
            duration: 0, // Persistent until dismissed
            id: "offline-warning",
        }),

    online: () => {
        dismissToast("offline-warning");

        return showSuccess(localized(msg`Connection restored!`), { duration: 3000 });
    },

    serverError: () =>
        showError(localized(msg`Server error. Please try again later.`), {
            duration: 6000,
        }),

    timeout: (retryFunction?: () => void) =>
        showError(localized(msg`Request timed out`), {
            action: retryFunction
                ? {
                      label: localized(msg`Retry`),
                      onClick: retryFunction,
                  }
                : undefined,
        }),
};

/**
 * Authentication-related toasts
 */
export const authToast = {
    sessionExpired: () =>
        showWarning(localized(msg`Your session has expired`), {
            action: {
                label: localized(msg`Sign In Again`),
                onClick: () => {
                    globalThis.location.assign("/auth/signin");
                },
            },
        }),

    signInRequired: () =>
        showWarning(localized(msg`Please sign in to continue`), {
            action: {
                label: localized(msg`Sign In`),
                onClick: () => {
                    // Navigate to sign in page
                    globalThis.location.assign("/auth/signin");
                },
            },
        }),
};
