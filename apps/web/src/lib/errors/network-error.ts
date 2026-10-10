/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Network and connectivity errors
 */
export class NetworkError extends AppError {
    public readonly isRetryable: boolean;

    constructor(message: string = "Network error occurred", isRetryable: boolean = true, details: ErrorDetails = {}) {
        super(message, {
            code: "NETWORK_ERROR",
            context: {
                isRetryable,
                ...details.context,
            },
            statusCode: 503,
            ...details,
        });
        this.isRetryable = isRetryable;
    }
}
