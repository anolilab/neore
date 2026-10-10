/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Base error for prompt improvement operations
 */
export class PromptImprovementError extends AppError {
    constructor(message: string, details: ErrorDetails = {}) {
        super(message, {
            code: "PROMPT_IMPROVEMENT_ERROR",
            statusCode: 400,
            ...details,
        });
    }
}
