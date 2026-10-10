/**
 * Async webhook reporter to the Lunora backend for credit deduction.
 *
 * After each LLM call, the gateway reports actual cost to the backend
 * so it can deduct from the user's credit balance.
 */
import type { AppEnv } from "../env.js";
import type { BillingMode } from "./billing.js";

export interface UsageReport {
    /** How the backend should bill this call. Absent (older reports) means `platform`. */
    billingMode?: BillingMode;
    /** Fraction of `costMicrodollars` charged for a `byok` call (validated `BYOK_FEE_RATE`). */
    byokFeeRate?: number;
    completionTokens: number;
    /** The call's full, undiscounted model cost — what analytics record. */
    costMicrodollars: number;
    modelId: string;
    orgId?: string;
    promptTokens: number;
    requestId: string;
    userId: string;
}

/** Attempts per report, including the first. */
export const USAGE_REPORT_MAX_ATTEMPTS = 4;
/** Backoff before retry n (1-based) is `BASE * 2^(n-1)`: 500 ms, 1 s, 2 s. */
export const USAGE_REPORT_BASE_DELAY_MS = 500;

/**
 * Deadline for one attempt. A hung connection would otherwise hold the whole
 * `waitUntil` open, and Cloudflare cancels that 30 s after the response: four
 * attempts at 5 s plus 3.5 s of backoff is 23.5 s, so every retry still runs.
 */
export const USAGE_REPORT_ATTEMPT_TIMEOUT_MS = 5000;

/** Worth retrying: the backend or the network failed, not the report itself. */
const isRetryableStatus = (status: number): boolean => status >= 500 || status === 429;

const defaultSleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

export interface UsageReporterOptions {
    baseDelayMs?: number;
    maxAttempts?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Per-attempt deadline; defaults to {@link USAGE_REPORT_ATTEMPT_TIMEOUT_MS}. */
    timeoutMs?: number;
}

export class UsageReporter {
    private lunoraUrl: string | undefined;

    private signingSecret: string | undefined;

    private readonly maxAttempts: number;

    private readonly baseDelayMs: number;

    private readonly sleep: (ms: number) => Promise<void>;

    private readonly timeoutMs: number;

    constructor(env: AppEnv, options: UsageReporterOptions = {}) {
        this.lunoraUrl = env.LUNORA_URL;
        this.signingSecret = env.SIGNING_SECRET;
        this.maxAttempts = options.maxAttempts ?? USAGE_REPORT_MAX_ATTEMPTS;
        this.baseDelayMs = options.baseDelayMs ?? USAGE_REPORT_BASE_DELAY_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.timeoutMs = options.timeoutMs ?? USAGE_REPORT_ATTEMPT_TIMEOUT_MS;
    }

    /**
     * Report usage to the backend for credit deduction.
     *
     * Callers run this under `executionCtx.waitUntil`, so retries never delay the
     * model response. A 5xx, 429 or network error is retried with exponential
     * backoff; any other status is final. Retries are safe because the backend
     * dedupes on `requestId` (also sent as `Idempotency-Key`) — a report that
     * landed but whose reply was lost is ignored the second time. Never throws.
     */
    async report(usage: UsageReport): Promise<void> {
        if (!this.lunoraUrl) {
            return;
        }

        const url = `${this.lunoraUrl}/gateway/usage-report`;
        const body = JSON.stringify(usage);

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            let isRetryable: boolean;

            try {
                // Signed per attempt: the signature carries a timestamp the backend checks for freshness.
                const response = await fetch(url, {
                    body,
                    headers: await buildReportHeaders(body, usage.requestId, this.signingSecret),
                    method: "POST",
                    signal: AbortSignal.timeout(this.timeoutMs),
                });

                // Nothing reads the reply, but an unconsumed body keeps the connection
                // open until GC — cancel it so the Worker releases it now.
                await response.body?.cancel();

                if (response.ok) {
                    return;
                }

                isRetryable = isRetryableStatus(response.status);
                console.error(`[UsageReporter] Usage report ${usage.requestId} rejected: ${response.status} (attempt ${attempt}/${this.maxAttempts})`);
            } catch (error) {
                isRetryable = true;
                console.error(`[UsageReporter] Failed to report usage ${usage.requestId} (attempt ${attempt}/${this.maxAttempts}):`, error);
            }

            if (!isRetryable) {
                return;
            }

            if (attempt < this.maxAttempts) {
                await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
            }
        }

        console.error(`[UsageReporter] Gave up on usage report ${usage.requestId} after ${this.maxAttempts} attempts — credits not deducted`);
    }
}

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const buildReportHeaders = async (body: string, requestId: string, signingSecret: string | undefined): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
    };

    // Sign the request if we have a signing secret
    if (signingSecret) {
        const timestamp = Date.now().toString();
        const bodyBytes = new TextEncoder().encode(body);
        const bodyHash = await sha256Hex(bodyBytes.buffer as ArrayBuffer);
        const message = `POST\n/gateway/usage-report\n${timestamp}\n${bodyHash}`;
        const signature = await hmacSha256Hex(signingSecret, message);

        headers["X-Signature"] = signature;
        headers["X-Timestamp"] = timestamp;
    }

    return headers;
};
