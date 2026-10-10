/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Authentication/authorization errors
 */
export class AuthenticationError extends AppError {
    constructor(message: string = "Authentication required", details: ErrorDetails = {}) {
        super(message, {
            code: "AUTHENTICATION_ERROR",
            statusCode: 401,
            ...details,
        });
    }
}
