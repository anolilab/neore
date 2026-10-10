/**
 * A small client for the Neore v1 API. No dependencies: `fetch` and web streams.
 *
 * Every failure becomes an `ApiError` carrying the server's stable `code`, so
 * commands and exit codes branch on the code rather than on status numbers or
 * message text. Transport failures get codes of their own (`network_error`,
 * `invalid_response`) so they are distinguishable from API answers.
 */
import { randomUUID } from "node:crypto";

export const API_PREFIX = "/api/v1";

/** `https://x.test//` → `https://x.test`, without a backtracking regex. */
export const stripTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

export class ApiError extends Error {
    public readonly code: string;

    public readonly details?: Record<string, unknown>;

    public readonly requestId?: string;

    public readonly status: number;

    public constructor(options: { code: string; details?: Record<string, unknown>; message: string; requestId?: string; status: number }) {
        super(options.message);
        this.name = "ApiError";
        this.code = options.code;
        this.details = options.details;
        this.requestId = options.requestId;
        this.status = options.status;
    }
}

/** Process exit codes, by error class. Documented in `neore --help`. */
export const EXIT = { auth: 3, error: 1, network: 6, notFound: 4, ok: 0, rateLimited: 5, usage: 2 } as const;

export const exitCodeFor = (error: unknown): number => {
    if (!(error instanceof ApiError)) {
        return EXIT.error;
    }

    switch (error.code) {
        case "daily_limit_reached":
        case "rate_limited": {
            return EXIT.rateLimited;
        }
        case "insufficient_scope":
        case "invalid_api_key":
        case "unauthenticated": {
            return EXIT.auth;
        }
        case "invalid_request": {
            return EXIT.usage;
        }
        case "network_error":
        case "service_unavailable": {
            return EXIT.network;
        }
        case "not_found": {
            return EXIT.notFound;
        }
        default: {
            return EXIT.error;
        }
    }
};

/** A one-line next step for the errors a user can act on. */
export const hintFor = (error: ApiError): string | undefined => {
    switch (error.code) {
        case "daily_limit_reached": {
            return "The account's daily limit is used up; it resets within 24 hours.";
        }
        case "insufficient_scope": {
            const required = error.details?.["required"];

            return `Create a key with ${Array.isArray(required) ? required.join(", ") : "the missing scope"} in Settings → API keys, then run \`neore login\`.`;
        }
        case "invalid_api_key":
        case "unauthenticated": {
            return "Run `neore login` with a valid key.";
        }
        case "network_error": {
            return "Check the API URL (`neore doctor`) and your connection.";
        }
        case "rate_limited": {
            const retry = error.details?.["retryAfterSeconds"];

            return typeof retry === "number" ? `Retry in ${String(Math.ceil(retry))}s.` : "Retry shortly.";
        }
        default: {
            return undefined;
        }
    }
};

/** Map a non-2xx response to an `ApiError`, tolerating bodies that are not ours (a proxy's HTML 502). */
export const errorFromResponse = async (response: Response): Promise<ApiError> => {
    const requestId = response.headers.get("X-Request-Id") ?? undefined;
    let body: unknown;

    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    const error = (body as { error?: { code?: unknown; details?: unknown; message?: unknown; requestId?: unknown } } | undefined)?.error;

    if (error && typeof error.code === "string") {
        return new ApiError({
            code: error.code,
            details: error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : undefined,
            message: typeof error.message === "string" ? error.message : error.code,
            requestId: typeof error.requestId === "string" ? error.requestId : requestId,
            status: response.status,
        });
    }

    return new ApiError({
        code: response.status >= 500 ? "service_unavailable" : "invalid_response",
        message: `Unexpected ${String(response.status)} ${response.statusText || "response"} from the API.`,
        requestId,
        status: response.status,
    });
};

/** Longest server-requested wait worth sitting through; beyond it the error surfaces. */
const MAX_RETRY_AFTER_MS = 10_000;

/** How long to wait before retrying, or `undefined` when the error is not retryable. */
export const retryDelayMs = (error: unknown, attempt: number): number | undefined => {
    if (!(error instanceof ApiError)) {
        return undefined;
    }

    if (error.code === "rate_limited") {
        const seconds = error.details?.["retryAfterSeconds"];
        const ms = typeof seconds === "number" ? seconds * 1000 : 1000;

        return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
    }

    if (error.code === "network_error" || error.code === "idempotency_in_progress" || error.status >= 500) {
        return 500 * 2 ** attempt;
    }

    return undefined;
};

export interface StreamEvent {
    error?: { code: string; message: string };
    /** `resume`: where the next request continues. */
    lastChunkIndex?: number;
    name?: string;
    skillId?: string;
    status?: string;
    text?: string;
    type: "done" | "error" | "reasoning" | "resume" | "speaker" | "text";
}

/** Split an NDJSON byte stream into parsed events. Tolerates chunk boundaries anywhere, including mid-character. */
export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();

            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

            let newline = buffer.indexOf("\n");

            while (newline !== -1) {
                const line = buffer.slice(0, newline).trim();

                buffer = buffer.slice(newline + 1);

                if (line) {
                    yield JSON.parse(line) as StreamEvent;
                }

                newline = buffer.indexOf("\n");
            }

            if (done) {
                if (buffer.trim()) {
                    yield JSON.parse(buffer) as StreamEvent;
                }

                return;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

export interface ClientOptions {
    apiKey: string;
    baseUrl: string;
    fetch?: typeof fetch;
    /** Retries for `request()` (not streams). Default 2. */
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Per-request deadline in ms (not applied to streams). Default 120s. */
    timeoutMs?: number;
}

export interface RequestOptions {
    body?: unknown;
    /** POSTs get one automatically so a retry cannot double-run. */
    idempotencyKey?: string;
    query?: Record<string, number | string | undefined>;
    signal?: AbortSignal;
    /** Overrides the client's deadline for this call (a blocking chat can take minutes). */
    timeoutMs?: number;
}

export class NeoreClient {
    readonly #apiKey: string;

    readonly #baseUrl: string;

    readonly #fetch: typeof fetch;

    readonly #retries: number;

    readonly #sleep: (ms: number) => Promise<void>;

    readonly #timeoutMs: number;

    public constructor(options: ClientOptions) {
        this.#apiKey = options.apiKey;
        this.#baseUrl = stripTrailingSlashes(options.baseUrl);
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#timeoutMs = options.timeoutMs ?? 120_000;
        this.#retries = options.retries ?? 2;
        this.#sleep =
            options.sleep ??
            (async (ms) => {
                await new Promise((resolve) => {
                    setTimeout(resolve, ms);
                });
            });
    }

    public url(path: string, query?: RequestOptions["query"]): string {
        const url = new URL(`${this.#baseUrl}${API_PREFIX}${path}`);

        const entries = Object.entries(query ?? {});

        for (const [key, value] of entries) {
            if (value !== undefined && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }

        return url.href;
    }

    public async raw(method: string, path: string, options: RequestOptions & { stream?: boolean } = {}): Promise<Response> {
        const headers: Record<string, string> = {
            Accept: options.stream ? "application/x-ndjson" : "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
        };

        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        if (method === "POST") {
            headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
        }

        const signals = [options.signal, options.stream ? undefined : AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs)].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        );
        let response: Response;

        try {
            response = await this.#fetch(this.url(path, options.query), {
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                headers,
                method,
                signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
            });
        } catch (error) {
            throw new ApiError({
                code: "network_error",
                message: `Could not reach ${this.#baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
                status: 0,
            });
        }

        if (!response.ok) {
            throw await errorFromResponse(response);
        }

        return response;
    }

    /**
     * Upload a file to `/api/v1/uploads` over TUS (https://tus.io) and answer
     * its upload id — the last segment of the `Location` the create returns,
     * which `POST /knowledge/files` takes. One create, then the whole body in a
     * single `PATCH`: a knowledge file is small enough that resuming buys
     * nothing here.
     */
    public async upload(bytes: Uint8Array, file: { mimeType: string; name: string }, timeoutMs = 300_000): Promise<string> {
        const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
        const send = async (url: string, init: RequestInit): Promise<Response> => {
            let response: Response;

            try {
                response = await this.#fetch(url, {
                    ...init,
                    headers: { Authorization: `Bearer ${this.#apiKey}`, "Tus-Resumable": "1.0.0", ...init.headers },
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                throw new ApiError({ code: "network_error", message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`, status: 0 });
            }

            if (!response.ok) {
                throw await errorFromResponse(response);
            }

            return response;
        };
        const created = await send(this.url("/uploads"), {
            headers: { "Upload-Length": String(bytes.byteLength), "Upload-Metadata": `filename ${base64(file.name)},mimeType ${base64(file.mimeType)}` },
            method: "POST",
        });
        const location = new URL(created.headers.get("Location") ?? "", this.url("/uploads")).href;

        await created.body?.cancel();

        const patched = await send(location, {
            body: bytes,
            headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
            method: "PATCH",
        });

        await patched.body?.cancel();

        return new URL(location).pathname.split("/").pop() ?? "";
    }

    /**
     * JSON request with retries on transport failures, 5xx and short rate
     * limits. A POST keeps ONE idempotency key across its attempts, which is
     * what makes retrying it safe: the server replays instead of re-running.
     */
    public async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const attemptOptions = method === "POST" ? { ...options, idempotencyKey: options.idempotencyKey ?? randomUUID() } : options;
        let response: Response;
        let attempt = 0;

        while (true) {
            try {
                response = await this.raw(method, path, attemptOptions);
                break;
            } catch (error) {
                const delay = attempt < this.#retries ? retryDelayMs(error, attempt) : undefined;

                if (delay === undefined) {
                    throw error;
                }

                await this.#sleep(delay);
                attempt += 1;
            }
        }

        try {
            return (await response.json()) as T;
        } catch {
            throw new ApiError({ code: "invalid_response", message: "The API answered with a body that is not JSON.", status: response.status });
        }
    }

    /**
     * The reply's events, across as many requests as it takes: one request reads
     * a bounded number of times server-side, then ends with a `resume` event,
     * and the next continues from its `lastChunkIndex`. `resume` is never
     * yielded — the caller sees one uninterrupted stream.
     */
    public async *stream(streamToken: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
        let lastChunkIndex: number | undefined;

        while (true) {
            const response = await this.raw("POST", "/chat/stream", {
                body: { resumable: true, streamToken, ...(lastChunkIndex !== undefined && { lastChunkIndex }) },
                signal,
                stream: true,
            });

            if (!response.body) {
                throw new ApiError({ code: "invalid_response", message: "The stream had no body.", status: response.status });
            }

            let resumeAt: number | undefined;

            for await (const event of parseNdjson(response.body)) {
                if (event.type === "resume") {
                    resumeAt = event.lastChunkIndex;
                } else {
                    yield event;
                }
            }

            if (resumeAt === undefined || signal?.aborted) {
                return;
            }

            lastChunkIndex = resumeAt;
        }
    }

    /** Every page of a list, following `nextCursor`. */
    public async listAll<T>(path: string, query: Record<string, string | undefined> = {}, max = 1000): Promise<T[]> {
        const items: T[] = [];
        let cursor: string | undefined;

        do {
            const page = await this.request<{ data: T[]; nextCursor: string | null }>("GET", path, { query: { ...query, cursor, limit: 100 } });

            items.push(...page.data);
            cursor = page.nextCursor ?? undefined;
        } while (cursor && items.length < max);

        return items.slice(0, max);
    }
}
