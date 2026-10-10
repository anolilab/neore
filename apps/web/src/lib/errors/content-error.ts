/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { ValidationError } from "./validation-error";

/**
 * Content/prompt related errors
 */
export class ContentError extends ValidationError {
    constructor(message: string, contentType: "prompt" | "instructions" | "response" = "prompt", details: ErrorDetails = {}) {
        super(message, contentType, undefined, {
            code: "CONTENT_ERROR",
            context: {
                contentType,
                ...details.context,
            },
            ...details,
        });
    }
}
