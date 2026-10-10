/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { AppError } from "./app-error";
import { AuthenticationError } from "./authentication-error";
import { DEFAULT_MESSAGE_LIMIT_MESSAGE, MessageLimitError } from "./message-limit-error";
import { NetworkError } from "./network-error";
import { RateLimitError } from "./rate-limit-error";
import { ServerError } from "./server-error";
import { TimeoutError } from "./timeout-error";
import { ValidationError } from "./validation-error";

export * from "./app-error";
export * from "./authentication-error";
export * from "./content-error";
export * from "./message-limit-error";
export * from "./network-error";
export * from "./prompt-improvement-error";
export * from "./rate-limit-error";
export * from "./server-error";
export * from "./timeout-error";
export * from "./validation-error";

/**
 * Error factory for creating errors from HTTP responses
 */
export const ErrorFactory = {
    fromBackendError(error: any): AppError {
        // The backend puts a structured payload on `error.data`; the rate-limit
        // shape is the one the UI reacts to.
        if (error?.data?.kind === "RateLimitError") {
            return new RateLimitError(error.message || "Rate limit exceeded", error.data.retryAfter || 60_000, {
                context: {
                    backendError: true,
                    name: error.data.name,
                },
            });
        }

        if (error?.message?.includes("Unauthorized")) {
            return new AuthenticationError(error.message);
        }

        if (error?.message?.includes("timeout")) {
            return new TimeoutError(30_000, error.message);
        }

        return new ServerError(error?.message || "Unknown server error", {
            context: {
                backendError: true,
                originalError: error,
            },
        });
    },

    fromResponse(response: Response, message?: string): AppError {
        const { status } = response;
        const defaultMessage = message || `HTTP ${status}: ${response.statusText}`;

        switch (status) {
            case 400: {
                return new ValidationError(defaultMessage);
            }
            case 401: {
                return new AuthenticationError(defaultMessage);
            }
            case 403: {
                // Check if it's a message limit error
                if (message?.includes("MESSAGE_LIMIT_REACHED") || message?.includes("message limit")) {
                    return new MessageLimitError(message);
                }

                return new AppError(defaultMessage, {
                    code: "FORBIDDEN",
                    statusCode: 403,
                });
            }
            case 408: {
                return new TimeoutError(30_000, defaultMessage);
            }
            case 429: {
                return new RateLimitError(defaultMessage);
            }
            case 500:
            case 502:
            case 503:
            case 504: {
                return new ServerError(defaultMessage);
            }
            default: {
                return new AppError(defaultMessage, {
                    code: "HTTP_ERROR",
                    statusCode: status,
                });
            }
        }
    },
};

/**
 * Helpers for classifying, retrying and presenting application errors.
 */
export const ErrorUtilities = {
    /**
     * Get retry delay for retryable errors.
     */
    getRetryDelay(error: Error, attempt: number = 1): number {
        if (error instanceof RateLimitError) {
            return error.retryAfter;
        }

        if (error instanceof TimeoutError) {
            // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
            return Math.min(1000 * 2 ** (attempt - 1), 30_000);
        }

        if (error instanceof NetworkError || error instanceof ServerError) {
            // Exponential backoff with jitter
            const baseDelay = 1000 * 2 ** (attempt - 1);
            const jitter = Math.random() * 1000;

            return Math.min(baseDelay + jitter, 30_000);
        }

        return 0;
    },

    /**
     * Get the user-friendly error message.
     *
     * Pass the component's `i18n` (from `useLingui()`) to get it in the
     * reader's language. Without it the helper cannot translate — the global
     * i18n is never activated here — and falls back to the English source
     * text in development and to `error.message` in a production build (whose
     * message descriptors carry only ids).
     */
    getUserMessage(error: Error, i18n?: I18n): string {
        const message = ErrorUtilities.getUserMessageDescriptor(error);

        if (typeof message === "string") {
            return message;
        }

        if (i18n) {
            return i18n._(message);
        }

        return message.message ?? error.message;
    },

    /**
     * The user-facing message for an error: a descriptor to translate, or the
     * error's own text when that is what should be shown (server or validation
     * messages).
     */
    getUserMessageDescriptor(error: Error): MessageDescriptor | string {
        if (error instanceof MessageLimitError) {
            return error.message === DEFAULT_MESSAGE_LIMIT_MESSAGE ? msg`You've reached the message limit. Please sign up to continue.` : error.message;
        }

        if (error instanceof RateLimitError) {
            const minutes = error.getRetryAfterMinutes();

            return msg`You've reached the rate limit. Please try again in ${plural(minutes, { one: "# minute", other: "# minutes" })}.`;
        }

        if (error instanceof AuthenticationError) {
            return msg`Please sign in to continue.`;
        }

        if (error instanceof ValidationError) {
            return error.message;
        }

        if (error instanceof NetworkError) {
            return msg`Connection error. Please check your internet connection and try again.`;
        }

        if (error instanceof TimeoutError) {
            return msg`Request timed out. Please try again.`;
        }

        if (error instanceof ServerError) {
            return msg`Something went wrong on our end. Please try again later.`;
        }

        return error.message || msg`An unexpected error occurred.`;
    },

    /**
     * Check if an error is retryable.
     */
    isRetryable(error: Error): boolean {
        if (error instanceof NetworkError) {
            return error.isRetryable;
        }

        if (error instanceof TimeoutError) {
            return true;
        }

        if (error instanceof ServerError) {
            return true;
        }

        if (error instanceof RateLimitError) {
            return true; // Can retry after waiting
        }

        return false;
    },
};

// All error types are already exported above with individual export statements
