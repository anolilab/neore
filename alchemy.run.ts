import { existsSync } from "node:fs";

import alchemy from "alchemy";
import type { Secret } from "alchemy";
import {
    Ai,
    D1Database,
    DurableObjectNamespace,
    EmailSender,
    KVNamespace,
    Queue,
    R2Bucket,
    R2RestStateStore,
    TanStackStart,
    VectorizeIndex,
    VectorizeMetadataIndex,
    Worker,
    Workflow,
} from "alchemy/cloudflare";

import backendBindings from "./backend/lunora-bindings.json" with { type: "json" };
import { OPTIONAL_ENV_KEYS, REQUIRED_ENV_KEYS } from "./backend/lunora/lib/env-validation";
import { JOBS_QUEUE_CONSUMER } from "./backend/lunora/lib/job-queue-config";
import { jobs, jobsDeadLetters } from "./backend/lunora/queues";
import { GATEWAY_CRONS } from "./services/llm-gateway/src/crons";
import { BACKEND_BUNDLE, RUST_WORKER_OUTPUT, RUST_WORKER_UPLOAD, WORKER_BUNDLE } from "./scripts/worker-bundle";

// ---------------------------------------------------------------------------
// Stage resolution
// ---------------------------------------------------------------------------
// DEPLOY_ENV is set by CI (production | preview).
// Locally you can override with `DEPLOY_ENV=production pnpm deploy`.
const stage = process.env.DEPLOY_ENV ?? "preview";

/**
 * Deploy-time values that must be present, checked BEFORE anything is built or
 * created.
 *
 * Two reasons this is up here rather than inline at the binding:
 *
 *  - The backend Worker used to deploy with no secrets at all, which is not a
 *    degraded deploy. better-auth silently falls back to its published default
 *    signing key, so the app comes up healthy while every session cookie and JWT
 *    it issues is forgeable by anyone who reads the package on npm.
 *  - Checked inline, the first failure surfaces only after the web app has been
 *    built and the first Worker is already being created — slow, and it leaves
 *    half-applied state behind. Collected here, a missing secret costs a second
 *    and touches nothing.
 */
const REQUIRED_DEPLOY_ENV = [
    /**
     * Alchemy encrypts every `alchemy.secret()` into the state file with this,
     * and it has no default — `alchemy()` falls back to `process.env.ALCHEMY_PASSWORD`
     * and nothing else. Unset, the deploy dies at the first secret binding with
     * "Cannot serialize secret without password", which is a fatal stop partway
     * through the graph rather than a clean refusal. It belongs in the same
     * up-front guard as the values it protects.
     *
     * It must also stay STABLE across deploys: rotate it and the existing state
     * file can no longer be decrypted, so every secret reads as unrecoverable.
     */
    // An env var NAME, not a value — the scanner's "Generic Password" rule
    // matches on the word alone.
    "ALCHEMY_PASSWORD", // secret-scanner:allow
    "BACKEND_PUBLIC_ORIGIN",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    // Gateway -> backend only: the gateway HMAC-signs its calls back to the
    // backend (`/chat/chunks`, usage reports, key validation) and verifies the
    // stream tokens the backend mints. Backend -> gateway goes over the
    // `SERVICE_LLM_GATEWAY` binding and signs nothing.
    "LLM_GATEWAY_SIGNING_SECRET",
    // The gateway's PUBLIC origin (the browser's `/v1/*`): its custom domain and
    // `PUBLIC_GATEWAY_URL`. The backend does not use it — it has the binding.
    "LLM_GATEWAY_URL",
    // Authenticates dispatch to `/_lunora/scheduler/dispatch` — from the jobs
    // queue consumer (`@lunora/queue` sends it as a bearer) and, lacking a
    // `LUNORA_SCHEDULER_SECRET`, from the SchedulerDO too. Unset, the endpoint
    // answers 403 DISPATCH_UNAUTHENTICATED to both, so no scheduled or queued
    // job would ever run on a Worker that deployed green.
    "LUNORA_ADMIN_TOKEN",
    "R2_ENDPOINT",
    "SITE_URL",
    // Signs `ctx.storage` download URLs (uploads go through the TUS route,
    // `lib/upload-route.ts`). Unset, every signed download in a stage fails.
    "STORAGE_SIGNING_SECRET",
] as const;

const missingDeployEnv = REQUIRED_DEPLOY_ENV.filter((name) => !process.env[name]?.trim());

if (missingDeployEnv.length > 0 && process.env.DESTROY !== "true") {
    throw new Error(
        `Cannot deploy (stage: ${stage}) — these are unset: ${missingDeployEnv.join(", ")}. ` +
            `Set them as repository secrets; there are deliberately no defaults, because a wrong or empty value here deploys a working-looking app with forgeable sessions.`,
    );
}

// The document parser is a Rust Worker deployed from its prebuilt output
// (`RUST_WORKER_UPLOAD`); Alchemy does not build it. Refused here, before
// anything is created, rather than as a "No files found" halfway through.
if (!RUST_WORKER_OUTPUT.every((file) => existsSync(`./services/document-parser/build/${file}`)) && process.env.DESTROY !== "true") {
    throw new Error(
        "Cannot deploy: services/document-parser/build/ is missing. Run `pnpm --filter document-parser run build:worker` first (needs the Rust toolchain).",
    );
}

const requireEnv = (name: (typeof REQUIRED_DEPLOY_ENV)[number]): string => process.env[name]!.trim();

/**
 * The custom domain a Worker should serve on, derived from the origin it is
 * ALREADY built against rather than from config of its own.
 *
 * `SITE_URL`, `BACKEND_PUBLIC_ORIGIN` and `LLM_GATEWAY_URL` are the three
 * origins the app is compiled with and the backend verifies its JWTs against.
 * Taking the hostname from them means a custom domain cannot disagree with the
 * origin the browser was told to use — which is the failure this repo has hit
 * twice already and which is silent both times (a mismatched `PUBLIC_ORIGIN`
 * makes every bearer token verify as anonymous; a mismatched gateway origin
 * CORS-rejects every call). One value, one source.
 *
 * A `*.workers.dev` origin yields NO custom domain, so the same script deploys
 * unchanged before a zone exists. Attaching a custom domain requires the zone to
 * be ACTIVE in this account — a zone still `pending` its nameserver change fails
 * here — so the cutover is: deploy on workers.dev, move the zone, flip the three
 * secrets, redeploy.
 */
const customDomain = (origin: string, name: (typeof REQUIRED_DEPLOY_ENV)[number]): { adopt: true; domainName: string }[] => {
    let hostname: string;

    try {
        ({ hostname } = new URL(origin));
    } catch {
        throw new Error(
            `Cannot deploy (stage: ${stage}) — ${name} is not a valid URL: ${JSON.stringify(origin)}. It must be an absolute origin, e.g. https://neore.ai.`,
        );
    }

    // `adopt` so a redeploy re-uses the hostname it already created instead of
    // failing on "already exists". It deliberately does NOT set
    // `overrideExistingOrigin`: stealing a hostname that another Worker is
    // serving should be a visible failure, not a silent takeover.
    return hostname.endsWith(".workers.dev") ? [] : [{ adopt: true, domainName: hostname }];
};

/**
 * Keys that are safe to ship as a PLAIN worker var. Everything else in the
 * pass-through below is wrapped in `alchemy.secret()`.
 *
 * The default is deliberately "secret": binding a non-secret as a secret costs
 * only dashboard visibility, while binding a secret as plain text puts it in
 * `wrangler` output and in every deployment listing. So this list is the
 * exceptions — ids, hostnames and addresses that are not credentials.
 */
const PLAIN_ENV_KEYS = new Set([
    "AMADEUS_CLIENT_ID",
    "APP_NAME",
    "AUTH_GITHUB_CLIENT_ID",
    "BROWSERBASE_PROJECT_ID",
    "CREEM_PRODUCT_PRO",
    "CREEM_PRODUCT_TEAM",
    "CREEM_TEST_MODE",
    "DPO_EMAIL",
    "GITHUB_CONNECTOR_CLIENT_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CONNECTOR_CLIENT_ID",
    "MAIL_FROM",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_TENANT_ID",
    "OIDC_BUTTON_LABEL",
    "OIDC_CLIENT_ID",
    "OIDC_ISSUER",
    "POSTHOG_HOST",
    "POSTHOG_PROJECT_ID",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "SIGNUP_INVITE_ONLY",
    "SLACK_CONNECTOR_CLIENT_ID",
    "SPOTIFY_CLIENT_ID",
    "TURNSTILE_SITE_KEY",
    // Web Push: the public half is handed to every browser anyway.
    "VAPID_PUBLIC_KEY",
    "VAPID_SUBJECT",
]);

/**
 * Bind one env var, as a secret unless it is in `PLAIN_ENV_KEYS`.
 *
 * An EMPTY value is always bound plain. It carries nothing worth encrypting,
 * and Cloudflare's secret API is not reliably happy with an empty `secret_text`
 * — which would turn "this optional provider is not configured" into a failed
 * deploy.
 */
const bindEnv = (name: string): string | Secret => {
    const value = process.env[name]?.trim() ?? "";

    if (value === "") {
        return "";
    }

    return PLAIN_ENV_KEYS.has(name) ? value : alchemy.secret(value);
};

/**
 * Every key `backend/lunora/lib/env-validation.ts` requires in production, bound
 * whether or not it has a value.
 *
 * This is not belt-and-braces. `http.ts` calls `assertEnv()` on EVERY request and
 * picks the strict schema whenever `ENVIRONMENT !== "development"` — which is
 * both stages here. Most of those fields are a bare `z.string()`, so an ABSENT
 * key fails validation while an EMPTY one passes. Thirty of the forty were never
 * bound, and the result is not a failed deploy: it is a Worker that deploys
 * green and answers 500 with "Environment validation failed" to every request,
 * including the health check.
 *
 * Read from the schema rather than listed here, so a new field in
 * `toolApiEnvSchema` cannot quietly reintroduce the same outage.
 * `backend/deploy-env-bindings.test.ts` fails if this stops covering it.
 */
const requiredEnvPassthrough = Object.fromEntries(REQUIRED_ENV_KEYS.map((name) => [name, bindEnv(name)]));

/**
 * Cloudflare Email Service, bound only when it is the transport to use.
 *
 * `email/mailer.ts` (`@lunora/mail`) prefers this binding whenever it exists, so
 * the deploy decides the transport. Email Service rejects an unverified sender
 * domain (`E_SENDER_NOT_VERIFIED`), so the binding is useless until a sending
 * subdomain exists on a zone in THIS account — and the product is in beta, so an
 * account without the entitlement could fail the deploy on a binding it cannot
 * create. Resend's key is therefore the switch, which makes the cutover a secret
 * change rather than a code change:
 *
 *   MAIL_FROM set, RESEND_API_KEY unset -> EMAIL bound -> Cloudflare Email Service
 *   MAIL_FROM set, RESEND_API_KEY set   -> no binding  -> Resend
 *
 * `MAIL_FROM` itself rides `requiredEnvPassthrough` (the mailer reads it for
 * every transport). `allowedSenderAddresses` pins the From to its address.
 * Destination is deliberately left unrestricted: `destinationAddress` /
 * `allowedDestinationAddresses` would cap delivery to verified addresses, and
 * this account sends signup and invitation mail to arbitrary users.
 */
const mailFrom = process.env.MAIL_FROM?.trim() ?? "";
/** `allowedSenderAddresses` takes the bare address of a `Name <addr@host>` sender. */
const mailFromAddress = /<([^<>]+)>\s*$/u.exec(mailFrom)?.[1]?.trim() ?? mailFrom;

// A record rather than `{ EMAIL } | {}`: spread, that union reads as an
// `EMAIL?: undefined` binding, which Alchemy's `Bindings` rejects.
const emailServiceBinding: Record<string, EmailSender> =
    mailFrom && !process.env.RESEND_API_KEY?.trim() ? { EMAIL: EmailSender({ allowedSenderAddresses: [mailFromAddress] }) } : {};

/**
 * The optional half, bound only where a value exists.
 *
 * These are `.optional()` in the schema, so absence is fine and binding twenty
 * empty strings would only add noise. Passing them through anyway means an
 * operator can turn on PostHog or Featurebase by adding a repo secret, with no
 * change to this file.
 */
const optionalEnvPassthrough = Object.fromEntries(
    OPTIONAL_ENV_KEYS.filter((name) => (process.env[name]?.trim() ?? "") !== "").map((name) => [name, bindEnv(name)]),
);

/**
 * Turnstile is two independent variables with nothing tying them together, and
 * it fails silently in both directions.
 *
 * `TURNSTILE_SECRET_KEY` alone: better-auth loads its captcha plugin, so every
 * credential endpoint demands a token — while the app, built without
 * `VITE_TURNSTILE_SITE_KEY`, renders no widget to produce one. Sign-up, sign-in
 * and forgot-password all answer `MISSING_RESPONSE`, with a submit button that
 * looks like it simply does nothing.
 *
 * `VITE_TURNSTILE_SITE_KEY` alone: users solve a challenge the server never
 * checks. Protection that looks present and is not.
 *
 * Neither: no captcha at all, which is a deliberate choice and stays allowed.
 * Both is the only other correct state, so require exactly one of those two.
 */
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
const turnstileSiteKey = process.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";

if (Boolean(turnstileSecret) !== Boolean(turnstileSiteKey) && process.env.DESTROY !== "true") {
    throw new Error(
        `Cannot deploy (stage: ${stage}) — Turnstile is half-configured. ` +
            `TURNSTILE_SECRET_KEY is ${turnstileSecret ? "set" : "unset"} and VITE_TURNSTILE_SITE_KEY is ${turnstileSiteKey ? "set" : "unset"}. ` +
            `Set both (the app collects the token, the backend verifies it) or neither. ` +
            `Secret-only kills every credential flow; site-key-only shows a challenge nothing verifies.`,
    );
}

/**
 * Production must be able to send mail. `@lunora/mail` throws without a sender,
 * so with `MAIL_FROM` unset every sign-up, password reset and invitation that
 * sends mail fails. With it set there is always a transport: the EMAIL binding,
 * or Resend when its key is set (see above).
 */
if (stage === "production" && !mailFrom && process.env.DESTROY !== "true") {
    throw new Error(
        "Cannot deploy (stage: production) — no outbound mail. Set MAIL_FROM to a verified sender: a Cloudflare Email Service " +
            "sending domain, or a Resend domain together with RESEND_API_KEY. Without it, password resets and invitations are never sent.",
    );
}

// ---------------------------------------------------------------------------
// Alchemy app
// ---------------------------------------------------------------------------
const app = await alchemy("neore-chat", {
    stage,
    // Explicit rather than relying on alchemy()'s own `process.env.ALCHEMY_PASSWORD`
    // fallback, so the coupling to the guard above is visible at the use site.
    password: requireEnv("ALCHEMY_PASSWORD"), // secret-scanner:allow — reads the env var, holds no literal
    phase: process.env.DESTROY === "true" ? "destroy" : undefined,
    // In CI use R2 for persistent state so every run sees previous state.
    // Locally, Alchemy defaults to the `.alchemy/` directory.
    stateStore:
        process.env.CI === "true"
            ? (scope) =>
                  new R2RestStateStore(scope, {
                      bucketName: "neore-chat-alchemy-state",
                  })
            : undefined,
});

// ---------------------------------------------------------------------------
// Main application – TanStack Start on Cloudflare Workers
// ---------------------------------------------------------------------------
// The app is pre-built by deploy.yml's "Build app" step (`pnpm build`: OG images,
// vite build, SW gen, tsc) — that step is where every `VITE_*` value and the
// raised NODE_OPTIONS heap live. This resource only UPLOADS the result:
// dist/server/index.js as the Worker (TanStackStart's default entrypoint,
// unbundled) and dist/client as assets.
export const website = await TanStackStart("website", {
    name: stage === "production" ? "neore-chat" : "neore-chat-preview",
    cwd: "./apps/web",
    domains: customDomain(requireEnv("SITE_URL"), "SITE_URL"),
    compatibilityDate: "2026-09-01",
    // The server routes read these through `process.env` (`api/scribe-token.ts`,
    // `lib/posthog/server.ts`). Since 2025-04-01 nodejs_compat fills it from the
    // bindings by default (`nodejs_compat_populate_process_env`).
    compatibilityFlags: ["nodejs_compat_v2"],
    bindings: {
        ...Object.fromEntries(
            ["ELEVENLABS_API_KEY", "POSTHOG_PERSONAL_API_KEY"].filter((name) => (process.env[name]?.trim() ?? "") !== "").map((name) => [name, bindEnv(name)]),
        ),
    },
    placement: { mode: "smart" },
    observability: { enabled: true },
    // Adopt existing Workers on first Alchemy run (safe migration).
    adopt: true,
    // NO second build. Alchemy's Vite resource defaults `build` to `vite build`
    // and runs it on every deploy, which would overwrite the prebuilt output with
    // one made in THIS step's environment — no `VITE_*` secrets, so the shipped
    // bundle has no backend URL, and no raised heap. An empty command is how to
    // opt out: `spreadBuildProps` keeps "" (it only defaults a nullish command)
    // and `Website` runs its build Exec only when the command is truthy, so
    // nothing is spawned at all.
    build: { command: "" },
});

// ---------------------------------------------------------------------------
// Document parser service – Rust (workers-rs + xberg) on Cloudflare Workers
// ---------------------------------------------------------------------------
//
// PRIVATE (`url: false` — Alchemy's `workers_dev: false`; it does not read the
// service's wrangler.jsonc): no workers.dev URL and no route, so the backend's
// `SERVICE_DOCUMENT_PARSER` binding is the only way in, and the Worker carries
// no auth of its own.
//
// Uploaded AS BUILT (`noBundle`): `pnpm --filter document-parser run
// build:worker` (worker-build) already emitted the bundled ES module and its
// wasm, and the deploy job runs it before this script (guarded above).
export const documentParser = await Worker("document-parser", {
    name: stage === "production" ? "document-parser" : "document-parser-preview",
    entrypoint: "./build/index.js",
    cwd: "./services/document-parser",
    url: false,
    ...RUST_WORKER_UPLOAD,
    compatibilityDate: "2026-09-01",
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    // Parsing is pure CPU: a text-dense 24 MB / 5,765-page PDF took 36s locally,
    // past the 30s default. 60s = the backend's own deadline for the call
    // (`FETCH_TIMEOUT_LONG_MS`); past that nobody is waiting for the answer.
    limits: {
        cpu_ms: 60_000,
    },
    // The Rust Worker reads no env: no vars, no secrets.
    bindings: {},
});

// ---------------------------------------------------------------------------
// NSFW checker service – Hono on Cloudflare Workers
// ---------------------------------------------------------------------------
//
// PRIVATE, like the document parser: reached only through `SERVICE_NSFW_CHECKER`.
export const nsfwChecker = await Worker("nsfw-checker", {
    name: stage === "production" ? "nsfw-checker" : "nsfw-checker-preview",
    entrypoint: "./src/index.ts",
    cwd: "./services/nsfw-checker",
    url: false,
    // Alchemy bundles unminified by default; see scripts/worker-bundle.ts.
    bundle: WORKER_BUNDLE,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat_v2"],
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    bindings: {
        NODE_ENV: stage === "production" ? "production" : "development",
        AI: Ai(),
    },
});

// ---------------------------------------------------------------------------
// Browser renderer service – @cloudflare/playwright on Cloudflare Workers
// ---------------------------------------------------------------------------
// Replaces Browserbase for AI agent browser automation.
// Uses CF Browser Rendering binding for serverless headless Chrome.
// PRIVATE, like the document parser: reached only through `SERVICE_BROWSER_RENDERER`.
export const browserRenderer = await Worker("browser-renderer", {
    name: stage === "production" ? "browser-renderer" : "browser-renderer-preview",
    entrypoint: "./src/index.ts",
    cwd: "./services/browser-renderer",
    url: false,
    // Alchemy bundles unminified by default; see scripts/worker-bundle.ts.
    bundle: WORKER_BUNDLE,
    compatibilityDate: "2025-09-15",
    compatibilityFlags: ["nodejs_compat"],
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    bindings: {
        NODE_ENV: stage === "production" ? "production" : "development",
        BROWSER: { type: "browser" },
    },
});

// ---------------------------------------------------------------------------
// Embeddings service – Workers AI text embeddings
// ---------------------------------------------------------------------------
// Replaces Google AI text-embedding-004 for memory and knowledge base.
// Default model: @cf/baai/bge-base-en-v1.5 (768 dimensions) to match existing vector table.
// NOTHING CALLS IT: memory and knowledge embed through the gateway, so it was
// left out of the move to service bindings (`backend/lunora.config.ts`) and no
// Worker is bound to it. PRIVATE (`url: false`) and given no `SIGNING_SECRET`,
// so it is unreachable, and `/embed` would answer 500 even if reached — its
// HMAC check fails closed. Give it a caller and it moves the way the other
// three did: declare it in `lunora.config.ts`, drop the HMAC from the Worker.
export const embeddingsWorker = await Worker("embeddings", {
    name: stage === "production" ? "embeddings" : "embeddings-preview",
    entrypoint: "./src/index.ts",
    cwd: "./services/embeddings",
    url: false,
    // Alchemy bundles unminified by default; see scripts/worker-bundle.ts.
    bundle: WORKER_BUNDLE,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat_v2"],
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    bindings: {
        NODE_ENV: stage === "production" ? "production" : "development",
        AI: Ai(),
    },
});

// ---------------------------------------------------------------------------
// LLM Gateway service – Hono on Cloudflare Workers
// ---------------------------------------------------------------------------
// R2 bucket for generated video blobs. Served via GET /v1/videos/:id/content.
// ---------------------------------------------------------------------------
export const llmGatewayVideoBucket = await R2Bucket("llm-gateway-videos", {
    name: `llm-gateway-videos-${stage}`,
    adopt: true,
});

// Cloudflare Queues for video render jobs.
//
// `POST /v1/videos` enqueues a `VideoRenderMessage` on the main queue; the
// Worker's `queue()` handler runs the render. Messages that exhaust the
// retry budget land on the DLQ — the same Worker tails it for logging.
//
// Decoupling the render from the HTTP request lifecycle is what makes this
// migration valuable: the render gets its own CPU/wall-clock budget, free
// retries for transient provider failures, and a clean telemetry root span.
export const llmGatewayVideoRendersDlq = await Queue("llm-gateway-video-renders-dlq", {
    name: `llm-gateway-video-renders-dlq-${stage}`,
    adopt: true,
    settings: {
        // Retain DLQ messages for the full 14 days so on-call can inspect
        // permanently-failed renders without racing a short retention window.
        messageRetentionPeriod: 14 * 24 * 60 * 60,
    },
});

export const llmGatewayVideoRenders = await Queue("llm-gateway-video-renders", {
    name: `llm-gateway-video-renders-${stage}`,
    adopt: true,
    dlq: llmGatewayVideoRendersDlq,
});

// R2 bucket for generated music blobs. Served via GET /v1/music/:id/content.
export const llmGatewayMusicBucket = await R2Bucket("llm-gateway-music", {
    name: `llm-gateway-music-${stage}`,
    adopt: true,
});

// Cloudflare Queues for music render jobs (same pattern as video — see above).
// Music typically renders faster (<30s) so retry_delay is tighter.
export const llmGatewayMusicRendersDlq = await Queue("llm-gateway-music-renders-dlq", {
    name: `llm-gateway-music-renders-dlq-${stage}`,
    adopt: true,
    settings: {
        messageRetentionPeriod: 14 * 24 * 60 * 60,
    },
});

export const llmGatewayMusicRenders = await Queue("llm-gateway-music-renders", {
    name: `llm-gateway-music-renders-${stage}`,
    adopt: true,
    dlq: llmGatewayMusicRendersDlq,
});

// Usage/API-key/health tables and the KV namespaces the gateway binds. A raw
// `{ type: "d1", database_name }` binding has no id, so the upload would fail;
// these are real resources. `migrationsDir` applies `migrations/*.sql` on every
// deploy (tracked in `d1_migrations`, the table `wrangler d1 migrations` uses).
export const llmGatewayUsageDb = await D1Database("llm-gateway-usage", {
    name: `llm-gateway-usage-${stage}`,
    adopt: true,
    migrationsDir: "./services/llm-gateway/migrations",
});

export const llmGatewayRateLimitKv = await KVNamespace("llm-gateway-ratelimit", { title: `llm-gateway-ratelimit-${stage}`, adopt: true });
export const llmGatewayPricingKv = await KVNamespace("llm-gateway-pricing", { title: `llm-gateway-pricing-${stage}`, adopt: true });
export const llmGatewayCacheKv = await KVNamespace("llm-gateway-cache", { title: `llm-gateway-cache-${stage}`, adopt: true });

// ---------------------------------------------------------------------------
// Proxies all LLM API calls with token counting, cost tracking,
// smart routing, and usage analytics. D1 for usage storage, KV for rate limiting.
// NOTE: provider API keys must be set as Cloudflare secrets.
export const llmGateway = await Worker("llm-gateway", {
    name: stage === "production" ? "llm-gateway" : "llm-gateway-preview",
    entrypoint: "./src/index.ts",
    cwd: "./services/llm-gateway",
    // Alchemy bundles unminified by default; see scripts/worker-bundle.ts.
    bundle: WORKER_BUNDLE,
    domains: customDomain(requireEnv("LLM_GATEWAY_URL"), "LLM_GATEWAY_URL"),
    // Pricing refresh, tier pools, usage aggregation, circuit-breaker reset.
    crons: GATEWAY_CRONS,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat_v2"],
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    // Video renders can spend most of their wall-clock waiting on provider
    // HTTP calls, but the render handler still needs more than the default
    // 30s CPU ceiling on cold paths (R2 streaming + token accounting).
    // 5 min is the platform maximum.
    limits: {
        cpu_ms: 300_000,
    },
    bindings: {
        APP_NAME: "llm-gateway",
        APP_VERSION: "1.0.0",
        NODE_ENV: stage === "production" ? "production" : "development",
        // The same secret the backend gets as LLM_GATEWAY_SIGNING_SECRET, from
        // the same source. It signs the gateway's calls BACK to the backend
        // (chunk polling, usage reports, key validation) and verifies the stream
        // tokens the backend mints — equal on both ends or every one is a 401.
        // It no longer guards `/internal/*`: those are served only to the
        // backend's `SERVICE_LLM_GATEWAY` binding, through the `InternalApi`
        // entrypoint, and the public handler answers them 404.
        SIGNING_SECRET: alchemy.secret(requireEnv("LLM_GATEWAY_SIGNING_SECRET")),
        // `website.url` is ALREADY a full origin — Alchemy's `createWorkerUrl`
        // returns `https://<name>.<subdomain>.workers.dev`. Interpolating it into
        // `https://${...}` produced `https://https://…`, and `middleware/security.ts`
        // splits this on "," and compares each entry to the request's `Origin`
        // header verbatim. It never matched, so every browser call to the gateway
        // was CORS-rejected — i.e. no chat at all, from a gateway that looked
        // configured.
        //
        // SITE_URL leads because that is the origin users actually arrive on
        // (a custom domain, once one is attached); the workers.dev URL is kept
        // alongside it so the deploy stays reachable before that happens.
        ALLOWED_ORIGINS: [
            ...new Set([requireEnv("SITE_URL"), website.url].filter((origin): origin is string => Boolean(origin))),
            ...(stage === "production" ? [] : ["http://localhost:3005", "http://localhost:5173", "http://localhost:4173"]),
        ].join(","),

        /**
         * The Lunora backend origin this gateway forwards to.
         *
         * Unbound, `forwardToBackend` in `routes/v1/chat.ts` answers every chat
         * request with a 500 `{"error":"Gateway not configured"}`, and the chunk
         * relay, the API-key check in `middleware/auth.ts` and the usage reporter
         * all fail the same way. Since the browser reaches the backend THROUGH
         * this worker, missing it means the product does nothing at all.
         *
         * Same value as the backend's own PUBLIC_ORIGIN and the app's
         * VITE_LUNORA_URL: three names for one origin, and drift between them
         * fails silently.
         */
        LUNORA_URL: requireEnv("BACKEND_PUBLIC_ORIGIN"),

        /**
         * This gateway's own canonical origin.
         *
         * `resolveCanonicalOrigin` prefers this over the request Host header when
         * it mints polling, content and webhook URLs — the header is attacker-
         * controlled, and a spoofed one would point a client at an origin where
         * the stream token (bearer-equivalent) gets replayed.
         */
        PUBLIC_GATEWAY_URL: requireEnv("LLM_GATEWAY_URL"),

        /** Where user-facing gateway errors deep-link their "fix-it" actions. */
        PUBLIC_DASHBOARD_URL: requireEnv("SITE_URL"),

        /**
         * Platform fee on BYOK model calls, as a fraction of model cost (0..1).
         * Bound only where set: unset, the gateway's `resolveByokFeeRate` uses its
         * 0.10 default; an invalid value is logged and also falls back to 0.10.
         */
        ...((process.env.BYOK_FEE_RATE?.trim() ?? "") === "" ? {} : { BYOK_FEE_RATE: process.env.BYOK_FEE_RATE!.trim() }),

        /**
         * Platform provider keys. Optional in `AppEnv`, so the gateway boots
         * without them — and then every model call fails unless the user brought
         * their own key. Bound only where set, so an unconfigured provider stays
         * absent rather than becoming an empty-string key that looks present.
         */
        ...Object.fromEntries(
            [
                "BFL_API_KEY",
                "CLOUDFLARE_ACCOUNT_ID",
                "CLOUDFLARE_API_KEY",
                "FAL_API_KEY",
                "GATEWAY_ADMIN_USER_IDS",
                "GOOGLE_API_KEY",
                "GROQ_API_KEY",
                "OPENAI_API_KEY",
                "OPENROUTER_API_KEY",
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "OTEL_EXPORTER_OTLP_HEADERS",
                "REQUESTY_API_KEY",
                "XAI_API_KEY",
            ]
                .filter((name) => (process.env[name]?.trim() ?? "") !== "")
                .map((name) => [name, bindEnv(name)]),
        ),
        USAGE_DB: llmGatewayUsageDb,
        RATE_LIMIT_KV: llmGatewayRateLimitKv,
        PRICING_KV: llmGatewayPricingKv,
        CACHE_KV: llmGatewayCacheKv,
        VIDEO_BUCKET: llmGatewayVideoBucket,
        VIDEO_RENDER_QUEUE: llmGatewayVideoRenders,
        MUSIC_BUCKET: llmGatewayMusicBucket,
        MUSIC_RENDER_QUEUE: llmGatewayMusicRenders,
        AI: Ai(),
    },
    eventSources: [
        {
            queue: llmGatewayVideoRenders,
            settings: {
                // One render per invocation — each render is heavy and we
                // already get parallelism via maxConcurrency.
                batchSize: 1,
                // Up to 10 concurrent render invocations cluster-wide. Each
                // invocation drives one provider HTTP call; cap reflects the
                // provider rate budget we're willing to spend.
                maxConcurrency: 10,
                // 2 retries on top of the initial delivery = 3 total
                // attempts. After that, DLQ.
                // MUST stay aligned with VIDEO_RENDER_MAX_ATTEMPTS in
                // services/llm-gateway/src/queue/video-render-consumer.ts —
                // the consumer's ack-vs-retry decision is gated on that
                // constant, and a mismatch silently drops messages on the
                // final attempt before the DLQ kicks in.
                maxRetries: 2,
                // Don't wait — flush each message immediately.
                maxWaitTimeMs: 1000,
                // 60s backoff matches the consumer's retry decision in
                // queue/video-render-consumer.ts.
                retryDelay: 60,
                deadLetterQueue: llmGatewayVideoRendersDlq,
            },
        },
        {
            queue: llmGatewayVideoRendersDlq,
            settings: {
                // DLQ is observed for logging, not retried. Use a small
                // batch + low concurrency since these are rare.
                batchSize: 10,
                maxConcurrency: 1,
                maxRetries: 0,
                maxWaitTimeMs: 30_000,
            },
        },
        {
            queue: llmGatewayMusicRenders,
            settings: {
                batchSize: 1,
                maxConcurrency: 10,
                // MUST stay aligned with MUSIC_RENDER_MAX_ATTEMPTS in
                // services/llm-gateway/src/queue/music-render-consumer.ts.
                maxRetries: 2,
                maxWaitTimeMs: 1000,
                // 30s backoff matches MUSIC_RENDER_RETRY_DELAY_SECONDS —
                // music providers usually clear transient failures faster
                // than video.
                retryDelay: 30,
                deadLetterQueue: llmGatewayMusicRendersDlq,
            },
        },
        {
            queue: llmGatewayMusicRendersDlq,
            settings: {
                batchSize: 10,
                maxConcurrency: 1,
                maxRetries: 0,
                maxWaitTimeMs: 30_000,
            },
        },
    ],
});

// ---------------------------------------------------------------------------
// Lunora backend – Durable Objects + D1 + R2 + Vectorize
// ---------------------------------------------------------------------------
// Alchemy owns the real resource ids; the
// placeholder ids in `backend/wrangler.jsonc` exist only to satisfy Lunora's
// wrangler validator during `lunora codegen` and are never deployed.
//
// `lunora deploy` is deliberately NOT used — it wraps `wrangler deploy` and
// would fight this graph. Codegen runs in the build (`pnpm --filter
// @neore/backend codegen`); schema migrations run as a post-deploy step via
// `lunora migrate up --url <worker>`.
export const backendDatabase = await D1Database("neore-backend-db", {
    name: stage === "production" ? "neore-backend" : "neore-backend-preview",
    adopt: true,
});

export const backendFiles = await R2Bucket("neore-backend-files", {
    name: stage === "production" ? "neore-files" : "neore-files-preview",
    adopt: true,
    // TUS uploads stream into multipart uploads. A part of one that never
    // completes is billed and invisible in a listing, so abort it after a week
    // (long enough that a paused, resumable upload can still finish).
    lifecycle: [
        {
            id: "abort-incomplete-multipart-uploads",
            enabled: true,
            abortMultipartUploadsTransition: {
                condition: { maxAge: 7 * 24 * 60 * 60, type: "Age" },
            },
        },
    ],
});

// One Vectorize index per embedding width, because a vector index pins
// `dimensions` for its whole life.
const EMBEDDING_DIMENSIONS = [128, 256, 512, 768, 1024, 1408, 1536, 2048, 3072, 4096] as const;

export const backendVectorIndexes = await Promise.all(
    EMBEDDING_DIMENSIONS.map(async (dimensions) =>
        VectorizeIndex(`neore-embeddings-${dimensions}`, {
            name: stage === "production" ? `embeddings-${dimensions}` : `embeddings-${dimensions}-preview`,
            dimensions,
            metric: "cosine",
            adopt: true,
        }),
    ),
);

// Vectorize filters only on properties with a metadata index, and only for
// vectors inserted AFTER the index exists. Message and memory search filter on
// these two keys (`agent/vector/index.ts#searchVectors`); without the indexes
// every filtered query matches nothing.
await Promise.all(
    backendVectorIndexes.flatMap((index) =>
        (["model_table_threadId", "model_table_userId"] as const).map(
            async (propertyName) => await VectorizeMetadataIndex(`${index.name}-${propertyName}`, { index, indexType: "string", propertyName }),
        ),
    ),
);

/**
 * The backend's jobs queue and its DLQ (`backend/lunora/queues.ts`).
 *
 * Agent runs, task rounds, eval cases and coding-agent steps are enqueued here
 * instead of on the SchedulerDO, whose alarm keeps at most six dispatches in
 * flight and waits on each (anolilab/lunora#793). The backend Worker is both
 * producer and consumer.
 *
 * Names, `maxRetries` and `retryDelay` come from the `defineQueue` exports;
 * batch size, batch wait and concurrency from `JOBS_QUEUE_CONSUMER`. Both are
 * what `backend/wrangler.jsonc` is tested against. A preview deploy suffixes
 * the names with `-preview`; the generated consumer knows those names from the
 * `env.preview` producers in `backend/wrangler.jsonc` (codegen reads them) —
 * keep the two in step.
 */
const queueName = (definition: { name?: string }): string => {
    if (!definition.name) {
        throw new Error("backend/lunora/queues.ts: every queue the deploy creates must declare its `name`");
    }

    return definition.name;
};
const jobsName = queueName(jobs);
const jobsDlqName = queueName(jobsDeadLetters);

export const backendJobsDlq = await Queue("neore-backend-jobs-dlq", {
    name: stage === "production" ? jobsDlqName : `${jobsDlqName}-preview`,
    adopt: true,
    settings: {
        messageRetentionPeriod: 14 * 24 * 60 * 60,
    },
});

export const backendJobs = await Queue("neore-backend-jobs", {
    name: stage === "production" ? jobsName : `${jobsName}-preview`,
    adopt: true,
    dlq: backendJobsDlq,
});

/**
 * Durable Objects, Workflows and cron triggers the backend needs, taken from the
 * manifest `lunora build --emit-bindings` writes out of the source.
 *
 * These were simply ABSENT here until the manifest was consulted, and none of
 * them fails loudly:
 *
 *  - No `SHARD`/`SCHEDULER` binding means every sharded table read and every
 *    `ctx.scheduler.runAfter` throws at runtime, on a Worker that deployed
 *    "successfully".
 *  - No workflow bindings means GDPR export, account deletion and chat import
 *    have no workflow to run — the exact failure `lunora prepare` warns about,
 *    but only if you run it.
 *  - No `crons` means all six scheduled jobs never fire. Nothing errors; the
 *    work just never happens.
 *
 * Only the stage-INDEPENDENT half is read from the manifest. Class names, the
 * workflow list and the cron expressions come from the code and are identical in
 * every environment. The D1 database, R2 bucket and Vectorize indexes are NOT
 * taken from it: those carry `-preview` suffixes and are Alchemy resources with
 * their own lifecycle, so they stay declared above.
 *
 * Regenerate with `pnpm --filter @neore/backend run build`, which passes
 * `--emit-bindings`. If a table gains a shard, a workflow is added or a cron
 * changes, the manifest moves and this follows without an edit.
 */
/** The manifest's binding entries are a loose union; this is the half we read. */
interface EmittedBinding {
    binding: string;
    className?: string;
    resource?: string;
    sqlite?: boolean;
    type: string;
}

const emitted = backendBindings.bindings as EmittedBinding[];

const backendDurableObjects = Object.fromEntries(
    emitted
        .filter((binding) => binding.type === "durable_object")
        .map((binding) => [
            binding.binding,
            DurableObjectNamespace(binding.binding.toLowerCase(), {
                className: binding.className as string,
                sqlite: binding.sqlite === true,
            }),
        ]),
);

const backendWorkflows = Object.fromEntries(
    emitted
        .filter((binding) => binding.type === "workflow")
        .map((binding) => [
            binding.binding,
            Workflow(binding.binding.toLowerCase(), {
                className: binding.className as string,
                // `resource` is the workflow NAME (`account-deletion-workflow`),
                // which is what Cloudflare provisions; `className` is the exported
                // class it dispatches to. Suffixed per stage like every other
                // named resource here, so preview cannot adopt production's.
                workflowName: stage === "production" ? (binding.resource as string) : `${binding.resource as string}-preview`,
            }),
        ]),
);

export const backend = await Worker("neore-backend", {
    name: stage === "production" ? "neore-backend" : "neore-backend-preview",
    entrypoint: "./src/server.ts",
    cwd: "./backend",
    // Minified, React production builds, English-only zod locales — see
    // scripts/worker-bundle.ts. `wrangler.jsonc`'s `minify` does not reach this.
    bundle: BACKEND_BUNDLE,
    domains: customDomain(requireEnv("BACKEND_PUBLIC_ORIGIN"), "BACKEND_PUBLIC_ORIGIN"),
    compatibilityDate: "2026-06-10",
    // See backend/wrangler.jsonc: keeps a Durable Object alive for its pending I/O.
    compatibilityFlags: ["nodejs_compat", "durable_object_io_tasks_prevent_eviction"],
    placement: { mode: "smart" },
    observability: { enabled: true },
    adopt: true,
    crons: backendBindings.crons,
    bindings: {
        // First, so every explicit binding below overrides its pass-through
        // counterpart — `ENVIRONMENT`, `SITE_URL` and friends are derived here,
        // not copied from the deploy runner's environment.
        ...requiredEnvPassthrough,
        ...optionalEnvPassthrough,
        ...backendDurableObjects,
        ...backendWorkflows,
        DB: backendDatabase,
        FILES: backendFiles,
        // Producer bindings under the names codegen derives from the exports
        // (`queueBindingName`); the DLQ's is how `@lunora/queue` would re-send
        // a message — it is bound for every declared queue.
        QUEUE_JOBS: backendJobs,
        QUEUE_JOBS_DEAD_LETTERS: backendJobsDlq,
        LUNORA_ADMIN_TOKEN: alchemy.secret(requireEnv("LUNORA_ADMIN_TOKEN")),
        NODE_ENV: stage === "production" ? "production" : "development",

        // Signing, encryption and the outbound services the backend cannot boot
        // without. `lib/env-validation.ts` is the full list; these are the ones
        // that were never bound at all.
        ADMIN: process.env.ADMIN ?? "",
        AUTH_SECRET: alchemy.secret(requireEnv("BETTER_AUTH_SECRET")),
        BETTER_AUTH_SECRET: alchemy.secret(requireEnv("BETTER_AUTH_SECRET")),
        ENCRYPTION_KEY: alchemy.secret(requireEnv("ENCRYPTION_KEY")),
        ENVIRONMENT: stage === "production" ? "production" : "preview",
        JWKS: process.env.JWKS ?? "",
        // Verifies the gateway's calls back here and signs stream tokens. The
        // backend reaches the gateway itself over `SERVICE_LLM_GATEWAY` below.
        LLM_GATEWAY_SIGNING_SECRET: alchemy.secret(requireEnv("LLM_GATEWAY_SIGNING_SECRET")),

        // The sibling Workers, as service bindings under the names Lunora
        // generates from `backend/lunora.config.ts` (`SERVICE_<KEY>`, also
        // written into backend/wrangler.jsonc `services[]`). No URL, no secret:
        // the three private ones have no other way in, and the gateway's
        // internal routes answer only its `InternalApi` entrypoint. Unbound, a
        // call fails naming the binding (`ctx.services.<key>`), and the optional
        // features (text extraction, NSFW check, browser tool) skip themselves.
        SERVICE_BROWSER_RENDERER: browserRenderer,
        SERVICE_DOCUMENT_PARSER: documentParser,
        SERVICE_LLM_GATEWAY: Worker.experimentalEntrypoint(llmGateway, "InternalApi"),
        SERVICE_NSFW_CHECKER: nsfwChecker,
        // `MAIL_FROM` and Resend's key ride `requiredEnvPassthrough` above; only
        // the Email Service binding is decided here. See `email/mailer.ts`.
        ...emailServiceBinding,
        R2_ENDPOINT: requireEnv("R2_ENDPOINT"),
        SITE_URL: requireEnv("SITE_URL"),
        STORAGE_SIGNING_SECRET: alchemy.secret(requireEnv("STORAGE_SIGNING_SECRET")),

        // The JWKS URL bearer tokens verify against, the base for signed storage
        // URLs, and the origin `ctx.scheduler` + crons dispatch back to.
        //
        // No default. A `workers.dev` URL is
        // `<worker>.<account-subdomain>.workers.dev`, and this script cannot know
        // the account subdomain — the single-label guess that used to be here
        // resolves to nothing, so the JWKS fetch could never succeed and every
        // browser RPC came back FORBIDDEN_SHARD.
        // The SchedulerDO reads this from its own env; without it every
        // `ctx.scheduler.runAfter/runAt` fails with "LUNORA_ORIGIN_URL env
        // binding must be set on the SchedulerDO". Same value as PUBLIC_ORIGIN —
        // it is the origin the scheduler calls back on.
        LUNORA_ORIGIN_URL: requireEnv("BACKEND_PUBLIC_ORIGIN"),
        PUBLIC_ORIGIN: requireEnv("BACKEND_PUBLIC_ORIGIN"),

        // Both halves. `auth.ts` loads the captcha plugin only when it has the
        // secret AND knows a site key exists, so binding one without the other
        // degrades to "no captcha" rather than locking every credential flow.
        // The guard above refuses to deploy in that state regardless.
        TURNSTILE_SECRET_KEY: turnstileSecret,
        TURNSTILE_SITE_KEY: turnstileSiteKey,
        ...Object.fromEntries(EMBEDDING_DIMENSIONS.map((dimensions, index) => [`EMBEDDINGS_${dimensions}`, backendVectorIndexes[index]])),
    },
    eventSources: [
        {
            queue: backendJobs,
            settings: { ...JOBS_QUEUE_CONSUMER, deadLetterQueue: backendJobsDlq, maxRetries: jobs.maxRetries, retryDelay: jobs.retryDelay },
        },
        {
            // Observed for logging, not retried (`jobsDeadLetters` acks it).
            queue: backendJobsDlq,
            settings: { batchSize: 10, maxConcurrency: 1, maxRetries: jobsDeadLetters.maxRetries, maxWaitTimeMs: 30_000 },
        },
    ],
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
console.log({
    stage,
    website: website.url,
    backend: backend.url,
    // documentParser / nsfwChecker / browserRenderer: private (`url: false`) —
    // reached only through the backend's service bindings. embeddings: private
    // and unbound.
    llmGateway: llmGateway.url,
});

await app.finalize();
