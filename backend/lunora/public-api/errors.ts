/**
 * The public API's one error shape:
 *
 *   { "error": { "code": "not_found", "message": "…", "requestId": "…", "details"?: {…} } }
 *
 * `code` is the contract — stable, snake_case, documented in the OpenAPI spec
 * and mapped by the CLI. `message` is for humans and may change.
 *
 * Procedure failures arrive as `LunoraError`s whose `code` is the backend's
 * SCREAMING_CASE vocabulary; `fromProcedureError` translates, and anything it
 * does not recognise becomes `internal_error` with a generic message so an
 * internal exception text never reaches a third-party caller.
 */

export const API_ERROR_CODES = {
    conflict: 409,
    daily_limit_reached: 429,
    forbidden: 403,
    idempotency_conflict: 422,
    idempotency_in_progress: 409,
    insufficient_scope: 403,
    internal_error: 500,
    invalid_api_key: 401,
    invalid_request: 400,
    not_found: 404,
    payload_too_large: 413,
    rate_limited: 429,
    service_unavailable: 503,
    unauthenticated: 401,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

export interface ApiErrorBody {
    error: {
        code: ApiErrorCode;
        details?: Record<string, unknown>;
        message: string;
        requestId?: string;
    };
}

/** Thrown by route handlers; the router's error boundary renders it. */
export class PublicApiError extends Error {
    public readonly code: ApiErrorCode;

    public readonly details?: Record<string, unknown>;

    public readonly status: number;

    public constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "PublicApiError";
        this.code = code;
        this.details = details;
        this.status = API_ERROR_CODES[code];
    }
}

const PROCEDURE_CODE_MAP: Record<string, ApiErrorCode> = {
    BAD_REQUEST: "invalid_request",
    CONFLICT: "conflict",
    FORBIDDEN: "forbidden",
    INVALID_INPUT: "invalid_request",
    NOT_FOUND: "not_found",
    PAYLOAD_TOO_LARGE: "payload_too_large",
    TOO_MANY_REQUESTS: "rate_limited",
    UNAUTHORIZED: "unauthenticated",
    UNPROCESSABLE: "invalid_request",
    VALIDATION_ERROR: "invalid_request",
};

/**
 * Translate a thrown value into a `PublicApiError`.
 *
 * The procedure's own message is kept for the 4xx family — it was written for
 * the signed-in user who is now the API caller ("You can have at most 50
 * tasks") — and replaced for everything else.
 */
export const fromProcedureError = (error: unknown): PublicApiError => {
    if (error instanceof PublicApiError) {
        return error;
    }

    const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : undefined;
    const mapped = code ? PROCEDURE_CODE_MAP[code] : undefined;

    if (mapped) {
        const message = error instanceof Error && error.message ? error.message : mapped;

        return new PublicApiError(mapped, message);
    }

    return new PublicApiError("internal_error", "An unexpected error occurred.");
};

export const errorBody = (error: PublicApiError, requestId?: string): ApiErrorBody => {
    return {
        error: {
            code: error.code,
            message: error.message,
            ...(error.details && { details: error.details }),
            ...(requestId && { requestId }),
        },
    };
};

export const errorResponse = (error: PublicApiError, requestId?: string, headers?: HeadersInit): Response => {
    const responseHeaders = new Headers(headers);

    if (requestId) {
        responseHeaders.set("X-Request-Id", requestId);
    }

    const retryAfter = error.details?.["retryAfterSeconds"];

    if (typeof retryAfter === "number") {
        responseHeaders.set("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
    }

    return Response.json(errorBody(error, requestId), { headers: responseHeaders, status: error.status });
};
