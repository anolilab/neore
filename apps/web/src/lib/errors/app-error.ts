/**
 * Custom error classes for the AI Chat application
 * Provides structured error handling with specific error types
 */

export interface ErrorDetails {
    code?: string;
    context?: Record<string, unknown>;
    retryAfter?: number;
    statusCode?: number;
}

/**
 * Base error class for all application errors
 */
export class AppError extends Error {
    public readonly code: string;

    public readonly statusCode: number;

    public readonly context: Record<string, unknown>;

    public readonly timestamp: Date;

    constructor(message: string, details: ErrorDetails = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = details.code || "UNKNOWN_ERROR";
        this.statusCode = details.statusCode || 500;
        this.context = details.context || {};
        this.timestamp = new Date();
    }

    toJSON() {
        return {
            code: this.code,
            context: this.context,
            message: this.message,
            name: this.name,
            stack: this.stack,
            statusCode: this.statusCode,
            timestamp: this.timestamp.toISOString(),
        };
    }
}
