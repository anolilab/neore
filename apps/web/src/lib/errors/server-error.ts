/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Server-side errors
 */
export class ServerError extends AppError {
    constructor(message: string = "Internal server error", details: ErrorDetails = {}) {
        super(message, {
            code: "SERVER_ERROR",
            statusCode: 500,
            ...details,
        });
    }
}
