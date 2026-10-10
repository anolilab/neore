/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Rate limiting error - when user exceeds allowed requests
 */
export class RateLimitError extends AppError {
    public readonly retryAfter: number;

    constructor(
        message: string = "Rate limit exceeded. Please try again later.",
        retryAfter: number = 60_000, // Default 1 minute
        details: ErrorDetails = {},
    ) {
        super(message, {
            code: "RATE_LIMIT_EXCEEDED",
            retryAfter,
            statusCode: 429,
            ...details,
        });
        this.retryAfter = retryAfter;
    }

    getRetryAfterSeconds(): number {
        return Math.ceil(this.retryAfter / 1000);
    }

    getRetryAfterMinutes(): number {
        return Math.ceil(this.retryAfter / 60_000);
    }
}
