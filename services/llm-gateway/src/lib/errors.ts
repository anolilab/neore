/**
 * Standardized gateway error codes and error class.
 */

export const ErrorCodes = {
    BAD_REQUEST: "BAD_REQUEST",
    BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
    CONTEXT_LIMIT_EXCEEDED: "CONTEXT_LIMIT_EXCEEDED",
    FORBIDDEN: "FORBIDDEN",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    MODEL_BLOCKED: "MODEL_BLOCKED",
    MODEL_RETIRED: "MODEL_RETIRED",
    MODEL_UNKNOWN: "MODEL_UNKNOWN",
    NOT_FOUND: "NOT_FOUND",
    PII_DETECTED: "PII_DETECTED",
    PRICING_UNAVAILABLE: "PRICING_UNAVAILABLE",
    PROMPT_INJECTION_DETECTED: "PROMPT_INJECTION_DETECTED",
    PROVIDER_ERROR: "PROVIDER_ERROR",
    PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
    PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
    RATE_LIMITED: "RATE_LIMITED",
    STREAM_WARMUP_EMPTY: "STREAM_WARMUP_EMPTY",
    STREAM_WARMUP_ERROR: "STREAM_WARMUP_ERROR",
    STREAM_WARMUP_TIMEOUT: "STREAM_WARMUP_TIMEOUT",
    UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type GatewayStatusCode = 200 | 400 | 401 | 403 | 404 | 410 | 429 | 500 | 502 | 503;

const STATUS_MAP: Record<ErrorCode, GatewayStatusCode> = {
    BAD_REQUEST: 400,
    BUDGET_EXCEEDED: 429,
    CONTEXT_LIMIT_EXCEEDED: 413 as GatewayStatusCode,
    FORBIDDEN: 403,
    INTERNAL_ERROR: 500,
    MODEL_BLOCKED: 403,
    MODEL_RETIRED: 410 as GatewayStatusCode,
    MODEL_UNKNOWN: 400,
    NOT_FOUND: 404,
    PII_DETECTED: 400,
    PRICING_UNAVAILABLE: 200, // Non-blocking — request still succeeds
    PROMPT_INJECTION_DETECTED: 400,
    PROVIDER_ERROR: 502,
    PROVIDER_NOT_CONFIGURED: 503,
    PROVIDER_UNAVAILABLE: 503,
    RATE_LIMITED: 429,
    STREAM_WARMUP_EMPTY: 502,
    STREAM_WARMUP_ERROR: 502,
    STREAM_WARMUP_TIMEOUT: 502,
    UNAUTHORIZED: 401,
};

/**
 * Stable, user-facing error catalog.
 *
 * Each entry maps an internal `ErrorCode` to:
 *   - `userFacingCode`: a stable `E_*` identifier the client can match on
 *     (independent of the HTTP status, so renames don't break clients).
 *   - `messageTemplate`: human-readable message with `{placeholder}` slots.
 *   - `actions`: deep-link "fix-it" actions. `path` is relative to the
 *     dashboard origin so the gateway doesn't need to know it at compile
 *     time; pass `dashboardUrl` to {@link enrichError} to materialize them.
 *
 * Keep in sync with the dashboard's error explainer page so the labels
 * line up with the UI the user lands on.
 */
export interface UserFacingAction {
    label: string;
    /** Path appended to the dashboard origin. Use `{placeholder}` for fields filled in by `enrichError`. */
    path: string;
}

export interface UserFacingErrorEntry {
    actions: ReadonlyArray<UserFacingAction>;
    messageTemplate: string;
    userFacingCode: string;
}

const USER_FACING_CATALOG: Partial<Record<ErrorCode, UserFacingErrorEntry>> = {
    BUDGET_EXCEEDED: {
        actions: [{ label: "Adjust limit", path: "/dashboard/settings/billing/limits" }],
        messageTemplate: "You've hit your spend limit for this billing period. Increase the limit in Billing → Limits, or wait for the next reset.",
        userFacingCode: "E_QUOTA_EXCEEDED",
    },
    CONTEXT_LIMIT_EXCEEDED: {
        actions: [
            { label: "Pick larger model", path: "/dashboard/settings/chat/model?minContext={contextWindow}" },
            { label: "Enable compression", path: "/dashboard/settings/chat/compression" },
        ],
        messageTemplate:
            "This request exceeds the model's context window ({estimatedTokens} > {contextWindow} tokens). Pick a larger-context model or enable compression.",
        userFacingCode: "E_CONTEXT_OVERFLOW",
    },
    MODEL_BLOCKED: {
        actions: [{ label: "Edit filter rules", path: "/dashboard/settings/compliance/model-filters" }],
        messageTemplate: "The selected model isn't allowed by your filter rules ({reason}). Loosen the rules in Settings → Compliance, or pick another model.",
        userFacingCode: "E_MODEL_BLOCKED",
    },
    MODEL_RETIRED: {
        actions: [{ label: "Choose another model", path: "/dashboard/settings/chat/model" }],
        messageTemplate: "{modelId} has been retired by its provider. Pick a successor model in the model picker.",
        userFacingCode: "E_MODEL_RETIRED",
    },
    MODEL_UNKNOWN: {
        actions: [{ label: "Choose another model", path: "/dashboard/settings/chat/model" }],
        messageTemplate: "We don't recognise the model `{modelId}`. Reset the default in Settings → Chat → Model.",
        userFacingCode: "E_MODEL_UNKNOWN",
    },
    PII_DETECTED: {
        actions: [{ label: "Adjust PII rules", path: "/dashboard/settings/compliance/pii" }],
        messageTemplate: "Personal information was detected in your message and the request was blocked.",
        userFacingCode: "E_PII_DETECTED",
    },
    PROMPT_INJECTION_DETECTED: {
        actions: [],
        messageTemplate: "Your message was blocked by content safety. Edit the message and try again.",
        userFacingCode: "E_CONTENT_POLICY",
    },
    PROVIDER_NOT_CONFIGURED: {
        actions: [{ label: "Add API key", path: "/dashboard/settings/api-keys?provider={provider}" }],
        messageTemplate: "{provider} isn't configured. Add an API key in Settings → API Keys, or pick a model from a provider you've already connected.",
        userFacingCode: "E_NO_PROVIDER_KEY",
    },
    PROVIDER_UNAVAILABLE: {
        actions: [{ label: "Provider status", path: "/status" }],
        messageTemplate: "{provider} is temporarily unavailable. We'll retry on a healthy provider — try again in a moment.",
        userFacingCode: "E_PROVIDER_DOWN",
    },
    RATE_LIMITED: {
        actions: [],
        messageTemplate: "Too many requests in the last minute. Try again shortly.",
        userFacingCode: "E_RATE_LIMITED",
    },
    STREAM_WARMUP_EMPTY: {
        actions: [],
        messageTemplate: "{modelId} closed the stream without producing any output.",
        userFacingCode: "E_PROVIDER_DOWN",
    },
    STREAM_WARMUP_ERROR: {
        actions: [],
        messageTemplate: "{modelId} errored before producing any output.",
        userFacingCode: "E_PROVIDER_DOWN",
    },
    STREAM_WARMUP_TIMEOUT: {
        actions: [],
        messageTemplate: "{modelId} didn't respond within the warm-up window. Retrying with a different model is recommended.",
        userFacingCode: "E_PROVIDER_SLOW",
    },
    UNAUTHORIZED: {
        actions: [{ label: "Sign in", path: "/login" }],
        messageTemplate: "You need to sign in to use this endpoint.",
        userFacingCode: "E_AUTH_REQUIRED",
    },
};

type TemplateVariable = string | number | undefined;

const TRAILING_SLASH_RE = /\/$/;

const renderTemplate = (template: string, variables: Record<string, TemplateVariable>): string =>
    template.replaceAll(/\{(\w+)\}/g, (_, key) => {
        const v = variables[key];

        return v === undefined ? `{${key}}` : String(v);
    });

const joinDashboardUrl = (dashboardUrl: string, path: string): string => {
    const base = dashboardUrl.replace(TRAILING_SLASH_RE, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;

    return `${base}${suffix}`;
};

/**
 * Enrich a `GatewayError`-shaped payload with user-facing fields. Returns
 * the original payload unchanged when no catalog entry is registered or
 * when `dashboardUrl` is missing (so action links can't be materialised).
 */
export const enrichError = (
    code: ErrorCode,
    fallbackMessage: string,
    variables: Record<string, TemplateVariable>,
    dashboardUrl: string | undefined,
): { actions?: { label: string; url: string }[]; userFacingCode?: string; userFacingMessage: string } => {
    const entry = USER_FACING_CATALOG[code];

    if (!entry) {
        return { userFacingMessage: fallbackMessage };
    }

    const message = renderTemplate(entry.messageTemplate, variables);

    if (!dashboardUrl || entry.actions.length === 0) {
        return { userFacingCode: entry.userFacingCode, userFacingMessage: message };
    }

    const actions = entry.actions.map((a) => {
        return {
            label: a.label,
            url: joinDashboardUrl(dashboardUrl, renderTemplate(a.path, variables)),
        };
    });

    return { actions, userFacingCode: entry.userFacingCode, userFacingMessage: message };
};

export class GatewayError extends Error {
    readonly code: ErrorCode;

    readonly statusCode: GatewayStatusCode;

    readonly details?: Record<string, TemplateVariable>;

    constructor(code: ErrorCode, message: string, details?: Record<string, TemplateVariable>) {
        super(message);
        this.name = "GatewayError";
        this.code = code;
        this.statusCode = STATUS_MAP[code];
        this.details = details;
    }

    toJSON(options: { dashboardUrl?: string } = {}) {
        const enriched = enrichError(this.code, this.message, this.details ?? {}, options.dashboardUrl);

        return {
            error: {
                code: this.code,
                message: this.message,
                ...(enriched.userFacingCode && { userFacingCode: enriched.userFacingCode }),
                ...(enriched.userFacingMessage !== this.message && { userFacingMessage: enriched.userFacingMessage }),
                ...(enriched.actions && enriched.actions.length > 0 && { actions: enriched.actions }),
                ...(this.details && { details: this.details }),
            },
        };
    }
}

/**
 * Generic, client-safe message map for upstream errors. Use these in
 * production responses; log the raw error.message via console.error
 * server-side. Pair the response with a `requestId` so support can map
 * a generic message back to the underlying error.
 */
const SAFE_PROVIDER_MESSAGE = "Provider request failed";
const SAFE_VALIDATION_MESSAGE = "Invalid request body";
const SAFE_INTERNAL_MESSAGE = "Internal gateway error";

export interface SafeErrorPayload {
    code: string;
    message: string;
    requestId?: string;
    /** Field-level Zod errors if applicable (paths only, not raw messages). */
    validationErrors?: Record<string, string[]>;
}

const isProduction = (env?: { NODE_ENV?: string }): boolean => env?.NODE_ENV === "production";

/**
 * Convert any error into a sanitized payload safe to return to a client.
 * In non-production environments the raw message is included to aid local
 * debugging. In production only the generic message + requestId is exposed.
 */
export const toSafeErrorPayload = (error: unknown, options: { code?: string; env?: { NODE_ENV?: string }; requestId?: string } = {}): SafeErrorPayload => {
    const { requestId } = options;
    const code = options.code ?? "PROVIDER_ERROR";

    // Always log the full error server-side for support/debug
    console.error(`[gateway:error] code=${code} requestId=${requestId ?? "-"}`, error);

    if (error instanceof GatewayError) {
        // GatewayErrors are already crafted for clients
        return {
            code: error.code,
            message: error.message,
            ...(requestId && { requestId }),
        };
    }

    if (isProduction(options.env)) {
        return {
            code,
            message: code === "INTERNAL_ERROR" ? SAFE_INTERNAL_MESSAGE : SAFE_PROVIDER_MESSAGE,
            ...(requestId && { requestId }),
        };
    }

    return {
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(requestId && { requestId }),
    };
};

/**
 * Convert a Zod-shaped error into a sanitized payload. In production the
 * raw message is replaced with field-level paths from `error.flatten()`.
 */
export const toSafeValidationPayload = (
    flatten: { fieldErrors: Record<string, string[] | undefined>; formErrors: string[] },
    options: { env?: { NODE_ENV?: string }; requestId?: string } = {},
): SafeErrorPayload => {
    const fieldErrors: Record<string, string[]> = {};

    for (const [k, v] of Object.entries(flatten.fieldErrors)) {
        if (Array.isArray(v) && v.length > 0) {
            // In production, mask the actual messages to "invalid" tokens
            // so we don't leak inferred constraints.
            fieldErrors[k] = isProduction(options.env) ? v.map(() => "invalid") : v;
        }
    }

    return {
        code: "BAD_REQUEST",
        message: SAFE_VALIDATION_MESSAGE,
        ...(options.requestId && { requestId: options.requestId }),
        ...(Object.keys(fieldErrors).length > 0 && { validationErrors: fieldErrors }),
    };
};
