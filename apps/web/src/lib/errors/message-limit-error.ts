/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/** The default message, recognised by `ErrorUtilities.getUserMessageDescriptor` to show it translated. */
export const DEFAULT_MESSAGE_LIMIT_MESSAGE = "You've reached the message limit. Please sign up to continue.";

/**
 * Message limit reached error for anonymous users
 */
export class MessageLimitError extends AppError {
    public readonly retryAfter?: number;

    constructor(message: string = DEFAULT_MESSAGE_LIMIT_MESSAGE, retryAfter?: number, details: ErrorDetails = {}) {
        super(message, {
            code: "MESSAGE_LIMIT_REACHED",
            retryAfter,
            statusCode: 403,
            ...details,
        });
        this.retryAfter = retryAfter;
    }
}
