/**
 * Environment bindings for the LLM Gateway Worker.
 *
 * D1 database, KV namespace, plain vars, and secrets.
 */
import type { MusicRenderMessage } from "./routes/v1/music-types.js";
import type { VideoRenderMessage } from "./routes/v1/video-types.js";

export interface AppEnv {
    // ── Cloudflare Workers AI binding ────────────────────────────────────
    /** Native AI binding — available when the worker has `[ai]` configured in wrangler */
    AI?: Ai;
    ALLOWED_ORIGINS?: string;
    // ── Plain vars ────────────────────────────────────────────────────────
    APP_NAME: string;
    APP_VERSION: string;
    /** Black Forest Labs direct-API key — used for the `bfl` provider image routes. */
    BFL_API_KEY?: string;

    /**
     * Platform fee charged on a BYOK model call, as a fraction of the call's
     * model cost (e.g. "0.10" = 10%). Parsed by `resolveByokFeeRate`: unset means
     * 0.10; a value outside 0..1 or unparseable is logged and also means 0.10;
     * "0" makes BYOK free. Platform-key calls are always charged in full and
     * custom endpoints never are.
     */
    BYOK_FEE_RATE?: string;

    /** KV namespace for prompt cache stats, idempotency keys, and response deduplication */
    CACHE_KV: KVNamespace;

    /** Cloudflare account ID — used for Workers AI REST API fallback when AI binding is unavailable */
    CLOUDFLARE_ACCOUNT_ID?: string;
    /** Cloudflare API token — used for Workers AI REST API fallback when AI binding is unavailable */
    CLOUDFLARE_API_KEY?: string;
    /** Deployment stage when set (`production`, `preview`, ...); only read as a second production signal beside `NODE_ENV`. */
    ENVIRONMENT?: string;
    FAL_API_KEY?: string;

    /**
     * Comma-separated list of admin user IDs allowed to access /internal/admin/* endpoints.
     * Defense-in-depth on top of HMAC: even with a valid HMAC signature, the request must
     * carry an `adminUserId` matching this allowlist. Empty/unset = admin endpoints disabled.
     */
    GATEWAY_ADMIN_USER_IDS?: string;
    GOOGLE_API_KEY?: string;

    GROQ_API_KEY?: string;

    /**
     * Override for idempotency cache TTL in seconds. Defaults to 86 400 (24h)
     * when unset. Capped at 7 days by the middleware.
     */
    IDEMPOTENCY_TTL_SECONDS?: string;

    /**
     * Origin of the Lunora backend Worker this gateway forwards to — chunk
     * polling, API-key validation, usage reporting and `/chat/start`.
     *
     * The same origin the app knows as `VITE_LUNORA_URL` and the backend knows
     * as its own `PUBLIC_ORIGIN`. One Lunora Worker serves `/_lunora/rpc`,
     * `/api/auth/*` and the HTTP routes, so there is no second `*_SITE_URL` to
     * keep in step — the split between an RPC origin and an HTTP origin that the
     * previous backend had is what an older second variable was carrying.
     */
    LUNORA_URL: string;

    /**
     * `1` swaps every language model for the deterministic mock in
     * `providers/mock-model.ts` — dev and e2e only, no provider key needed. Set
     * in a production environment it fails every request instead.
     */
    MOCK_LLM?: string;

    /** R2 bucket for generated music blobs. Served via GET /v1/music/:id/content. */
    MUSIC_BUCKET: R2Bucket;

    /**
     * Producer binding for music render jobs. POST /v1/music enqueues a
     * {@link MusicRenderMessage} here; same dispatch pattern as video.
     */
    MUSIC_RENDER_QUEUE: Queue<MusicRenderMessage>;

    NODE_ENV: string;
    OPENAI_API_KEY?: string;
    // ── Provider API keys (platform defaults) ───────────────────────────
    OPENROUTER_API_KEY?: string;

    /**
     * Base URL of an OTLP/HTTP collector (e.g. https://api.honeycomb.io,
     * https://otel.signoz.cloud, or a self-hosted collector). When unset,
     * telemetry collection is a no-op — useful for local dev.
     * The exporter appends `/v1/traces` and `/v1/metrics` automatically.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;

    // ── OpenTelemetry export (optional) ──────────────────────────────────

    /**
     * Comma-separated `key=value` header pairs sent with every OTLP request.
     * Used for vendor auth tokens, e.g. `x-honeycomb-team=...,x-honeycomb-dataset=...`.
     */
    OTEL_EXPORTER_OTLP_HEADERS?: string;

    /** Logical service identifier. Defaults to `APP_NAME` when unset. */
    OTEL_SERVICE_NAME?: string;
    /** Separate KV namespace for pricing/routing cache (avoids key collisions with rate limiting) */
    PRICING_KV: KVNamespace;

    /**
     * Public origin of the dashboard / web app (e.g. `https://chat.example.com`).
     * Used to materialise deep-link "fix-it" actions in user-facing error
     * payloads (see `enrichError` in `lib/errors.ts`). When unset, errors omit
     * the `actions` array.
     */
    PUBLIC_DASHBOARD_URL?: string;

    /**
     * Public canonical origin of this gateway (e.g. `https://gateway.example.com`).
     * Used when the gateway needs to advertise its own URL back to clients (e.g. the
     * `gatewayUrl` field in /v1/chat responses). MUST NOT be derived from the request
     * Host header — attackers can spoof Host and trick clients into streaming from
     * an attacker-controlled origin where the bearer-equivalent stream token would
     * be replayed. Falls back to the request origin only in non-production.
     */
    PUBLIC_GATEWAY_URL?: string;

    RATE_LIMIT_KV: KVNamespace;
    REQUESTY_API_KEY?: string;

    /**
     * Model ID (as it appears in the gateway catalogue) used to grade routing
     * difficulty before model selection. Leave unset to route purely on the
     * local heuristic scorer — the classifier is an accuracy upgrade, not a
     * requirement, and every failure path falls back to the scorer.
     *
     * Pick something cheap and fast: the call sits in front of the user's
     * turn, and a verdict that arrives after the deadline is discarded.
     */
    ROUTING_CLASSIFIER_MODEL?: string;
    // ── Secrets (set via `wrangler secret put`) ─────────────────────────
    /** HMAC shared secret for Backend &lt;-> Gateway auth */
    SIGNING_SECRET: string;
    // ── Cloudflare bindings ──────────────────────────────────────────────
    USAGE_DB: D1Database;

    /** R2 bucket for generated video blobs. Served via GET /v1/videos/:id/content. */
    VIDEO_BUCKET: R2Bucket;

    /**
     * Producer binding for video render jobs. POST /v1/videos enqueues a
     * {@link VideoRenderMessage} here; the Worker's `queue()` handler in
     * src/index.ts consumes it. Decoupling the render from the HTTP request
     * lets it run with its own CPU/wall-clock budget and emit telemetry
     * outside the request lifecycle.
     */
    VIDEO_RENDER_QUEUE: Queue<VideoRenderMessage>;
    XAI_API_KEY?: string;
}

/** Hono context variables set by middleware */
export interface AppVariables {
    apiKeyId: string;
    orgId: string | undefined;
    requestId: string;
    /** Root server span — child spans should pass this as `parent`. */
    rootSpan: import("./lib/otel/index.js").Span;
    /** Per-request telemetry collector (OTLP traces + metrics). */
    telemetry: import("./lib/otel/index.js").RequestTelemetry;
    userId: string;
    userTier: string;
    usesOwnKeys: boolean;
}

/** Combined Hono env type — use this as the generic for OpenAPIHono/createMiddleware */
export interface HonoEnv {
    Bindings: AppEnv;
    Variables: AppVariables;
}
