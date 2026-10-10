/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

import type { ErrorDetails } from "./app-error";
import { AppError } from "./app-error";

/**
 * Input validation errors
 */
export class ValidationError extends AppError {
    public readonly field?: string;

    public readonly validationRules?: string[];

    constructor(message: string, field?: string, validationRules?: string[], details: ErrorDetails = {}) {
        super(message, {
            code: "VALIDATION_ERROR",
            context: {
                field,
                validationRules,
                ...details.context,
            },
            statusCode: 400,
            ...details,
        });
        this.field = field;
        this.validationRules = validationRules;
    }
}
