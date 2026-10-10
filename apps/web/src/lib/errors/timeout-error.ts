/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { NetworkError } from "./network-error";

/**
 * Timeout errors
 */
export class TimeoutError extends NetworkError {
    public readonly timeoutMs: number;

    constructor(timeoutMs: number = 30_000, message: string = `Request timed out after ${timeoutMs}ms`, details: ErrorDetails = {}) {
        super(message, true, {
            code: "TIMEOUT_ERROR",
            context: {
                timeoutMs,
                ...details.context,
            },
            statusCode: 408,
            ...details,
        });
        this.timeoutMs = timeoutMs;
    }
}
