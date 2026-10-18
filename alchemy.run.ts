import { existsSync } from "node:fs";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import backendBindings from "./backend/lunora-bindings.json" with { type: "json" };
import { OPTIONAL_ENV_KEYS, REQUIRED_ENV_KEYS } from "./backend/lunora/lib/env-validation";
import { JOBS_QUEUE_CONSUMER } from "./backend/lunora/lib/job-queue-config";
import { jobs, jobsDeadLetters } from "./backend/lunora/queues";
import { GATEWAY_CRONS } from "./services/llm-gateway/src/crons";
import { BACKEND_BUILD, RUST_WORKER_OUTPUT, RUST_WORKER_UPLOAD, WEB_UPLOAD_RULES, WORKER_BUILD } from "./scripts/worker-bundle";

// ---------------------------------------------------------------------------
// Stage resolution
// ---------------------------------------------------------------------------
// DEPLOY_ENV is set by CI (production | staging | preview | pr-<n>) and passed as
// `--stage` too, so the state scope and the physical names below cannot disagree.
// Locally you can override with `DEPLOY_ENV=production alchemy deploy`.
//
// The stage is also a suffix of every physical name and a DNS label of the
// workers.dev hostnames, so it is held to a label that fits both.
const stage = process.env.DEPLOY_ENV ?? process.env.ALCHEMY_STAGE ?? "preview";

if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/u.test(stage)) {
    throw new Error(`Cannot deploy — the stage ${JSON.stringify(stage)} must be 1-20 lowercase letters, digits or hyphens, not starting or ending with one.`);
}

/**
 * Workers Logs bill per event, and logging every request is most of that bill.
 * 10% head sampling keeps the shape of traffic at a tenth of the events.
 */
const WORKER_OBSERVABILITY = { enabled: true, headSamplingRate: 0.1 };

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

// Destroying and checking drift read the cloud; they need none of the build output or
// secrets below, so the guards stand down. A deploy never sets either variable.
const destroying = process.env.DESTROY === "true" || process.env.READ_ONLY === "true";
const missingDeployEnv = REQUIRED_DEPLOY_ENV.filter((name) => !process.env[name]?.trim());

if (missingDeployEnv.length > 0 && !destroying) {
    throw new Error(
        `Cannot deploy (stage: ${stage}) — these are unset: ${missingDeployEnv.join(", ")}. ` +
            `Set them as repository secrets; there are deliberately no defaults, because a wrong or empty value here deploys a working-looking app with forgeable sessions.`,
    );
}

// The document parser is a Rust Worker deployed from its prebuilt output
// (`RUST_WORKER_UPLOAD`); Alchemy does not build it. Refused here, before
// anything is created, rather than as a "No files found" halfway through.
if (!RUST_WORKER_OUTPUT.every((file) => existsSync(`./services/document-parser/build/${file}`)) && !destroying) {
    throw new Error(
        "Cannot deploy: services/document-parser/build/ is missing. Run `pnpm --filter document-parser run build:worker` first (needs the Rust toolchain).",
    );
}

// The web app is built ahead of the deploy (`pnpm build` in deploy.yml: every `VITE_*`
// value, the raised heap, OG images, the service worker) and uploaded as built.
if (!existsSync("./apps/web/dist/server/index.js") && !destroying) {
    throw new Error("Cannot deploy: apps/web/dist/server/index.js is missing. Run `pnpm build` in apps/web first.");
}

const requireEnv = (name: (typeof REQUIRED_DEPLOY_ENV)[number]): string => process.env[name]?.trim() ?? "";

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
 *
 * A redeploy re-uses the hostname it already created (`--adopt` in CI). It does
 * not take over a hostname another Worker is serving: that stays a visible failure.
 */
const customDomain = (origin: string, name: (typeof REQUIRED_DEPLOY_ENV)[number]): string | undefined => {
    if (destroying) {
        return undefined;
    }

    let hostname: string;

    try {
        ({ hostname } = new URL(origin));
    } catch {
        throw new Error(
            `Cannot deploy (stage: ${stage}) — ${name} is not a valid URL: ${JSON.stringify(origin)}. It must be an absolute origin, e.g. https://neore.ai.`,
        );
    }

    return hostname.endsWith(".workers.dev") ? undefined : hostname;
};

/**
 * Keys that are safe to ship as a PLAIN worker var. Everything else in the
 * pass-through below is bound as a secret.
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

/** A value bound as a secret (`secret_text`); a plain string is bound as `plain_text`. */
const secret = (value: string): Redacted.Redacted<string> => Redacted.make(value);

/**
 * Bind one env var, as a secret unless it is in `PLAIN_ENV_KEYS`.
 *
 * An EMPTY value is always bound plain. It carries nothing worth encrypting,
 * and Cloudflare's secret API is not reliably happy with an empty `secret_text`
 * — which would turn "this optional provider is not configured" into a failed
 * deploy.
 */
const bindEnv = (name: string): string | Redacted.Redacted<string> => {
    const value = process.env[name]?.trim() ?? "";

    if (value === "") {
        return "";
    }

    return PLAIN_ENV_KEYS.has(name) ? value : secret(value);
};

/** The listed env vars that have a value, bound by `bindEnv`. Unset ones stay absent. */
const boundWhereSet = (names: readonly string[]): Record<string, string | Redacted.Redacted<string>> =>
    Object.fromEntries(names.filter((name) => (process.env[name]?.trim() ?? "") !== "").map((name) => [name, bindEnv(name)]));

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
 * The optional half, bound only where a value exists.
 *
 * These are `.optional()` in the schema, so absence is fine and binding twenty
 * empty strings would only add noise. Passing them through anyway means an
 * operator can turn on PostHog or Featurebase by adding a repo secret, with no
 * change to this file.
 */
const optionalEnvPassthrough = boundWhereSet(OPTIONAL_ENV_KEYS);

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
const useEmailService = mailFrom !== "" && !process.env.RESEND_API_KEY?.trim();

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

if (Boolean(turnstileSecret) !== Boolean(turnstileSiteKey) && !destroying) {
    throw new Error(
        `Cannot deploy (stage: ${stage}) — Turnstile is half-configured. ` +
            `TURNSTILE_SECRET_KEY is ${turnstileSecret ? "set" : "unset"} and VITE_TURNSTILE_SITE_KEY is ${turnstileSiteKey ? "set" : "unset"}. ` +
            `Set both (the app collects the token, the backend verifies it) or neither. ` +
            `Secret-only kills every credential flow; site-key-only shows a challenge nothing verifies.`,
    );
}

/**
 * Cloudflare Access in front of the web app of a non-production stage. Staging and
 * preview live on public workers.dev URLs; with this on, nobody who is not on the
 * `ADMIN` list even reaches the app. Only the web Worker is gated: the browser calls
 * the backend and the gateway cross-origin, and an Access login on the web hostname
 * does not carry over to theirs (they stay public, but every call needs a session
 * the invite-only sign-up hands out).
 *
 * Opt-in with `ACCESS_ENABLED=true` (a GitHub environment variable): Access needs a
 * Zero Trust organisation in the account and a token with the Access permissions, and a
 * deploy fails without them. Production never uses it.
 */
const accessEmails = (process.env.ADMIN ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
const accessEnabled = stage !== "production" && process.env.ACCESS_ENABLED === "true";

if (accessEnabled && accessEmails.length === 0 && !destroying) {
    throw new Error(`Cannot deploy (stage: ${stage}) — ACCESS_ENABLED is set but ADMIN lists no address to let through.`);
}

/**
 * Production must be able to send mail. `@lunora/mail` throws without a sender,
 * so with `MAIL_FROM` unset every sign-up, password reset and invitation that
 * sends mail fails. With it set there is always a transport: the EMAIL binding,
 * or Resend when its key is set (see above).
 */
if (stage === "production" && !mailFrom && !destroying) {
    throw new Error(
        "Cannot deploy (stage: production) — no outbound mail. Set MAIL_FROM to a verified sender: a Cloudflare Email Service " +
            "sending domain, or a Resend domain together with RESEND_API_KEY. Without it, password resets and invitations are never sent.",
    );
}

/**
 * Physical names carry the stage; production keeps the bare name. The backend strips
 * the suffix from its queue names to route them (`backend/src/queue-stage.ts`), so the
 * stage must stay the LAST part of a queue name.
 */
const named = (name: string): string => (stage === "production" ? name : `${name}-${stage}`);
const staged = (name: string): string => `${name}-${stage}`;

const COMPATIBILITY_DATE = "2026-09-01";

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
// R2 bucket for generated video blobs. Served via GET /v1/videos/:id/content.
const VideoBucket = Cloudflare.R2.Bucket("llm-gateway-videos", { name: staged("llm-gateway-videos") });

// Cloudflare Queues for video render jobs.
//
// `POST /v1/videos` enqueues a `VideoRenderMessage` on the main queue; the
// Worker's `queue()` handler runs the render. Messages that exhaust the
// retry budget land on the DLQ — the same Worker tails it for logging.
//
// Decoupling the render from the HTTP request lifecycle is what makes this
// migration valuable: the render gets its own CPU/wall-clock budget, free
// retries for transient provider failures, and a clean telemetry root span.
//
// NOT EXPRESSIBLE in Alchemy 2: the 14-day `messageRetentionPeriod` the DLQs had
// (`Queue` takes only a name), so they keep Cloudflare's default until it does.
const VideoRendersDlq = Cloudflare.Queues.Queue("llm-gateway-video-renders-dlq", { name: staged("llm-gateway-video-renders-dlq") });
const VideoRenders = Cloudflare.Queues.Queue("llm-gateway-video-renders", { name: staged("llm-gateway-video-renders") });

// R2 bucket for generated music blobs. Served via GET /v1/music/:id/content.
const MusicBucket = Cloudflare.R2.Bucket("llm-gateway-music", { name: staged("llm-gateway-music") });

// Cloudflare Queues for music render jobs (same pattern as video — see above).
// Music typically renders faster (<30s) so retry_delay is tighter.
const MusicRendersDlq = Cloudflare.Queues.Queue("llm-gateway-music-renders-dlq", { name: staged("llm-gateway-music-renders-dlq") });
const MusicRenders = Cloudflare.Queues.Queue("llm-gateway-music-renders", { name: staged("llm-gateway-music-renders") });

// Usage/API-key/health tables and the KV namespaces the gateway binds. `migrations`
// applies `migrations/*.sql` on every deploy; a database previously migrated with
// `wrangler d1 migrations apply` is converted ONE WAY to Alchemy's own bookkeeping
// table (`__alchemy_migrations`) on the first deploy.
const GatewayUsageDb = Cloudflare.D1.Database("llm-gateway-usage", {
    migrations: "./services/llm-gateway/migrations",
    name: staged("llm-gateway-usage"),
});

// Native rate-limit bindings for the gateway: one per per-minute limit value, as
// `services/llm-gateway/src/middleware/native-rate-limit.ts` expects. A namespace id
// is account-wide, so production (9101-9108, as in `services/llm-gateway/wrangler.jsonc`)
// and preview (9201-9208) count apart. Moving preview onto production's ids would let
// preview traffic spend a production user's budget.
const RATE_LIMIT_NAMESPACE_BASE = stage === "production" ? 9100 : 9200;
const gatewayRateLimits = Object.fromEntries(
    [2, 5, 15, 20, 30, 60, 120, 600].map((limit, index) => [
        `RATE_LIMIT_${limit}`,
        Cloudflare.RateLimit(`RATE_LIMIT_${limit}`, { namespaceId: RATE_LIMIT_NAMESPACE_BASE + index + 1, simple: { limit, period: 60 } }),
    ]),
);

const GatewayRateLimitKv = Cloudflare.KV.Namespace("llm-gateway-ratelimit", { title: staged("llm-gateway-ratelimit") });
const GatewayPricingKv = Cloudflare.KV.Namespace("llm-gateway-pricing", { title: staged("llm-gateway-pricing") });
const GatewayCacheKv = Cloudflare.KV.Namespace("llm-gateway-cache", { title: staged("llm-gateway-cache") });

// Alchemy owns the real resource ids; the placeholder ids in `backend/wrangler.jsonc`
// exist only to satisfy Lunora's wrangler validator during `lunora codegen` and are
// never deployed.
//
// `lunora deploy` is deliberately NOT used — it wraps `wrangler deploy` and
// would fight this graph. Codegen runs in the build (`pnpm --filter
// @neore/backend codegen`). Table DDL needs no step: the runtime applies root and
// `.shardBy()` tables from the schema, and `.global()` tables are created on first
// access. The schema-drift gate runs in `pnpm build` (`lunora build`), before this
// deploy. Only a data backfill (`defineMigration`) needs `lunora migrate up --prod
// --yes --url <worker>` after the deploy; none exists yet.
const BackendDatabase = Cloudflare.D1.Database("neore-backend-db", { name: named("neore-backend") });

const BackendFiles = Cloudflare.R2.Bucket("neore-backend-files", {
    name: named("neore-files"),
    // TUS uploads stream into multipart uploads. A part of one that never
    // completes is billed and invisible in a listing, so abort it after a week
    // (long enough that a paused, resumable upload can still finish).
    lifecycleRules: [
        {
            abortMultipartUploadsTransition: { condition: { maxAge: 7 * 24 * 60 * 60, type: "Age" } },
            enabled: true,
            id: "abort-incomplete-multipart-uploads",
        },
    ],
});

// One Vectorize index per embedding width, because a vector index pins
// `dimensions` for its whole life. Vectorize caps an index at 1536 dimensions
// (`IndexInvalidConfig: Dimensions must be in range: [32, 1536]`), so no wider
// width exists here or in `backend/lunora/agent/vector/tables.ts`.
const EMBEDDING_DIMENSIONS = [128, 256, 512, 768, 1024, 1408, 1536] as const;

const embeddingIndexes = EMBEDDING_DIMENSIONS.map((dimensions) => ({
    dimensions,
    index: Cloudflare.Vectorize.Index(`neore-embeddings-${dimensions}`, {
        dimensions,
        metric: "cosine",
        name: named(`embeddings-${dimensions}`),
    }),
}));

// Vectorize filters only on properties with a metadata index, and only for
// vectors inserted AFTER the index exists. Message and memory search filter on
// these two keys (`agent/vector/index.ts#searchVectors`); without the indexes
// every filtered query matches nothing.
const EMBEDDING_METADATA_PROPERTIES = ["model_table_threadId", "model_table_userId"] as const;

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
 * what `backend/wrangler.jsonc` is tested against. A non-production deploy
 * suffixes the names with its stage and the backend's `queue()` strips it again
 * (`STAGE` below); the `env.preview` producers in `backend/wrangler.jsonc` are what
 * `lunora dev` and codegen read.
 */
const queueName = (definition: { name?: string }): string => {
    if (!definition.name) {
        throw new Error("backend/lunora/queues.ts: every queue the deploy creates must declare its `name`");
    }

    return definition.name;
};
const jobsName = named(queueName(jobs));
const jobsDlqName = named(queueName(jobsDeadLetters));

const BackendJobsDlq = Cloudflare.Queues.Queue("neore-backend-jobs-dlq", { name: jobsDlqName });
const BackendJobs = Cloudflare.Queues.Queue("neore-backend-jobs", { name: jobsName });

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
 *    work just never happens. Production gets them; a preview deploy does not.
 *
 * Only the stage-INDEPENDENT half is read from the manifest. Class names, the
 * workflow list and the cron expressions come from the code and are identical in
 * every environment. The D1 database, R2 bucket and Vectorize indexes are NOT
 * taken from it: those carry the stage suffix and are Alchemy resources with
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

// Alchemy 2 creates new Durable Object classes SQLite-backed, which is what every
// class in the manifest is (`sqlite: true`); a KV-backed class would need a different tool.
const backendDurableObjects = Object.fromEntries(
    emitted
        .filter((binding) => binding.type === "durable_object")
        .map((binding) => {
            if (binding.sqlite !== true) {
                throw new Error(`backend/lunora-bindings.json: ${binding.binding} is not SQLite-backed, which Alchemy 2 cannot create.`);
            }

            return [binding.binding, Cloudflare.DurableObject(binding.className as string)] as const;
        }),
);

const backendWorkflows = Object.fromEntries(
    emitted
        .filter((binding) => binding.type === "workflow")
        .map((binding) => [
            binding.binding,
            // `resource` is the workflow NAME (`account-deletion-workflow`), which is what
            // Cloudflare provisions; `className` is the exported class it dispatches to.
            // Suffixed per stage like every other named resource here, so preview cannot
            // adopt production's.
            Cloudflare.Workflow(binding.className as string, { workflowName: named(binding.resource as string) }),
        ]),
);

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------
// Document parser service – Rust (workers-rs + xberg) on Cloudflare Workers
//
// PRIVATE (`workersDev: false`): no workers.dev URL and no route, so the backend's
// `SERVICE_DOCUMENT_PARSER` binding is the only way in, and the Worker carries
// no auth of its own.
//
// Uploaded AS BUILT (`bundle: false`): `pnpm --filter document-parser run
// build:worker` (worker-build) already emitted the bundled ES module and its
// wasm, and the deploy job runs it before this script (guarded above).
export const DocumentParser = Cloudflare.Worker("document-parser", {
    ...RUST_WORKER_UPLOAD,
    compatibility: { date: COMPATIBILITY_DATE },
    // Parsing is pure CPU: a text-dense 24 MB / 5,765-page PDF took 36s locally,
    // past the 30s default. 60s = the backend's own deadline for the call
    // (`FETCH_TIMEOUT_LONG_MS`); past that nobody is waiting for the answer.
    limits: { cpuMs: 60_000 },
    main: "./services/document-parser/build/index.js",
    name: named("document-parser"),
    observability: WORKER_OBSERVABILITY,
    placement: { mode: "smart" },
    workersDev: false,
});

// NSFW checker service – Hono on Cloudflare Workers
//
// PRIVATE, like the document parser: reached only through `SERVICE_NSFW_CHECKER`.
export const NsfwChecker = Cloudflare.Worker("nsfw-checker", {
    build: WORKER_BUILD,
    compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat_v2"] },
    env: {
        AI: Cloudflare.Workers.AI(),
        NODE_ENV: stage === "production" ? "production" : "development",
    },
    main: "./services/nsfw-checker/src/index.ts",
    name: named("nsfw-checker"),
    observability: WORKER_OBSERVABILITY,
    placement: { mode: "smart" },
    workersDev: false,
});

// Browser renderer service – @cloudflare/playwright on Cloudflare Workers
// Replaces Browserbase for AI agent browser automation.
// Uses CF Browser Rendering binding for serverless headless Chrome.
// PRIVATE, like the document parser: reached only through `SERVICE_BROWSER_RENDERER`.
export const BrowserRenderer = Cloudflare.Worker("browser-renderer", {
    build: WORKER_BUILD,
    compatibility: { date: "2025-09-15", flags: ["nodejs_compat"] },
    env: {
        BROWSER: Cloudflare.Browser(),
        NODE_ENV: stage === "production" ? "production" : "development",
    },
    main: "./services/browser-renderer/src/index.ts",
    name: named("browser-renderer"),
    observability: WORKER_OBSERVABILITY,
    placement: { mode: "smart" },
    workersDev: false,
});

// The embeddings Worker (`services/embeddings`) is not deployed: nothing calls it,
// memory and knowledge embed through the gateway. Its source stays in the repo.
// Deploying it again means declaring it here and giving it a caller.

// Main application – TanStack Start on Cloudflare Workers
//
// The app is pre-built by deploy.yml's "Build app" step (`pnpm build`: OG images,
// vite build, SW gen, tsc) — that step is where every `VITE_*` value and the
// raised NODE_OPTIONS heap live. This Worker only UPLOADS the result
// (`bundle: false`): dist/server/index.js with its chunks, and dist/client as
// assets. It is a plain Worker rather than `Website.Vite` because that one runs
// `vite build` itself, in this step's environment — no `VITE_*` secrets, so the
// shipped bundle would have no backend URL — and replaces `@cloudflare/vite-plugin`.
// The assets block is `apps/web/wrangler.jsonc`'s.
export const Website = Cloudflare.Worker("website", {
    assets: {
        directory: "./apps/web/dist/client",
        htmlHandling: "none",
        notFoundHandling: "none",
        // Server routes that override static files in dist/client.
        runWorkerFirst: ["/robots.txt", "/sitemap.xml"],
    },
    bundle: false,
    compatibility: {
        date: COMPATIBILITY_DATE,
        // The server routes read these through `process.env` (`api/scribe-token.ts`,
        // `lib/posthog/server.ts`). Since 2025-04-01 nodejs_compat fills it from the
        // bindings by default (`nodejs_compat_populate_process_env`).
        // `global_fetch_strictly_public`: the auth proxy and the server-side calls reach the
        // backend by its public URL. Without the flag a Worker's fetch to another Worker of
        // the SAME ACCOUNT on workers.dev (every non-production stage) is refused by the
        // runtime with a 404 ("error code: 1042"), so sign-up and every server-rendered
        // call failed in 3 ms while the backend answered fine to a browser.
        flags: ["nodejs_compat_v2", "global_fetch_strictly_public"],
    },
    domain: customDomain(requireEnv("SITE_URL"), "SITE_URL"),
    env: boundWhereSet(["ELEVENLABS_API_KEY", "POSTHOG_PERSONAL_API_KEY"]),
    // Only the web Worker, and only where ACCESS_ENABLED asks for it (see above).
    ...(accessEnabled ? { access: { policies: [{ decision: "allow" as const, include: accessEmails.map((email) => ({ email })) }], previews: false } } : {}),
    main: "./apps/web/dist/server/index.js",
    name: named("neore-chat"),
    observability: WORKER_OBSERVABILITY,
    placement: { mode: "smart" },
    // Under Cloudflare's 64 MiB module cap only because the browser-only chunks are left out.
    rules: WEB_UPLOAD_RULES,
});

// ---------------------------------------------------------------------------
// LLM Gateway service – Hono on Cloudflare Workers
// ---------------------------------------------------------------------------
// Proxies all LLM API calls with token counting, cost tracking,
// smart routing, and usage analytics. D1 for usage storage, KV for rate limiting.
// NOTE: provider API keys must be set as Cloudflare secrets.
const llmGatewayEnv = (siteOrigins: Output.Output<string | undefined>) => ({
    APP_NAME: "llm-gateway",
    APP_VERSION: "1.0.0",
    // `siteOrigins` is the Website's workers.dev origin, ALREADY a full origin — built
    // as `https://${...}` once, it produced `https://https://…`, and
    // `middleware/security.ts` splits ALLOWED_ORIGINS on "," and compares each entry
    // to the request's `Origin` header verbatim. It never matched, so every browser
    // call to the gateway was CORS-rejected — i.e. no chat at all, from a gateway
    // that looked configured.
    //
    // SITE_URL leads because that is the origin users actually arrive on
    // (a custom domain, once one is attached); the workers.dev URL is kept
    // alongside it so the deploy stays reachable before that happens.
    ALLOWED_ORIGINS: Output.map(siteOrigins, (workersDevOrigin) =>
        [
            ...new Set([requireEnv("SITE_URL"), workersDevOrigin ?? ""].filter((origin) => origin !== "")),
            ...(stage === "production" ? [] : ["http://localhost:3005", "http://localhost:5173", "http://localhost:4173"]),
        ].join(","),
    ),
    CACHE_KV: GatewayCacheKv,
    // The Lunora backend origin this gateway forwards to.
    //
    // Unbound, `forwardToBackend` in `routes/v1/chat.ts` answers every chat
    // request with a 500 `{"error":"Gateway not configured"}`, and the chunk
    // relay, the API-key check in `middleware/auth.ts` and the usage reporter
    // all fail the same way. Since the browser reaches the backend THROUGH
    // this worker, missing it means the product does nothing at all.
    //
    // Same value as the backend's own PUBLIC_ORIGIN and the app's
    // VITE_LUNORA_URL: three names for one origin, and drift between them
    // fails silently.
    LUNORA_URL: requireEnv("BACKEND_PUBLIC_ORIGIN"),
    MUSIC_BUCKET: MusicBucket,
    MUSIC_RENDER_QUEUE: MusicRenders,
    NODE_ENV: stage === "production" ? "production" : "development",
    PRICING_KV: GatewayPricingKv,
    // Where user-facing gateway errors deep-link their "fix-it" actions.
    PUBLIC_DASHBOARD_URL: requireEnv("SITE_URL"),
    // This gateway's own canonical origin.
    //
    // `resolveCanonicalOrigin` prefers this over the request Host header when
    // it mints polling, content and webhook URLs — the header is attacker-
    // controlled, and a spoofed one would point a client at an origin where
    // the stream token (bearer-equivalent) gets replayed.
    PUBLIC_GATEWAY_URL: requireEnv("LLM_GATEWAY_URL"),
    RATE_LIMIT_KV: GatewayRateLimitKv,
    ...gatewayRateLimits,
    // The same secret the backend gets as LLM_GATEWAY_SIGNING_SECRET, from
    // the same source. It signs the gateway's calls BACK to the backend
    // (chunk polling, usage reports, key validation) and verifies the stream
    // tokens the backend mints — equal on both ends or every one is a 401.
    // It no longer guards `/internal/*`: those are served only to the
    // backend's `SERVICE_LLM_GATEWAY` binding, through the `InternalApi`
    // entrypoint, and the public handler answers them 404.
    SIGNING_SECRET: secret(requireEnv("LLM_GATEWAY_SIGNING_SECRET")),
    USAGE_DB: GatewayUsageDb,
    VIDEO_BUCKET: VideoBucket,
    VIDEO_RENDER_QUEUE: VideoRenders,
    AI: Cloudflare.Workers.AI(),
    // Platform fee on BYOK model calls, as a fraction of model cost (0..1).
    // Bound only where set: unset, the gateway's `resolveByokFeeRate` uses its
    // 0.10 default; an invalid value is logged and also falls back to 0.10.
    ...((process.env.BYOK_FEE_RATE?.trim() ?? "") === "" ? {} : { BYOK_FEE_RATE: process.env.BYOK_FEE_RATE!.trim() }),
    // Platform provider keys. Optional in `AppEnv`, so the gateway boots
    // without them — and then every model call fails unless the user brought
    // their own key. Bound only where set, so an unconfigured provider stays
    // absent rather than becoming an empty-string key that looks present.
    ...boundWhereSet([
        "BFL_API_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_KEY",
        "DAILY_REQUEST_LIMITS",
        "DAILY_TOKEN_LIMITS",
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
    ]),
});

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------
export default Alchemy.Stack(
    "neore-chat",
    {
        providers: Cloudflare.providers(),
        // Persisted in a Worker + Durable Object in this account, bootstrapped by the
        // first `alchemy deploy --yes` (CI=true). Locally the default is `.alchemy/`.
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const website = yield* Website;

        const gateway = yield* Cloudflare.Worker("llm-gateway", {
            build: WORKER_BUILD,
            // Pricing refresh, tier pools, usage aggregation, circuit-breaker reset.
            // Production only, for the same reason as the backend's crons.
            // `global_fetch_strictly_public`: the gateway calls the backend by its public URL,
            // which on workers.dev is another Worker of this account (see `Website`).
            compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat_v2", "global_fetch_strictly_public"] },
            crons: stage === "production" ? [...GATEWAY_CRONS] : [],
            domain: customDomain(requireEnv("LLM_GATEWAY_URL"), "LLM_GATEWAY_URL"),
            env: llmGatewayEnv(website.url),
            // Video renders can spend most of their wall-clock waiting on provider
            // HTTP calls, but the render handler still needs more than the default
            // 30s CPU ceiling on cold paths (R2 streaming + token accounting).
            // 5 min is the platform maximum.
            limits: { cpuMs: 300_000 },
            main: "./services/llm-gateway/src/index.ts",
            name: named("llm-gateway"),
            observability: WORKER_OBSERVABILITY,
            placement: { mode: "smart" },
        });

        // Queue consumers. `maxRetries` + the first delivery is the attempt count the
        // consumers assume: VIDEO_RENDER_MAX_ATTEMPTS / MUSIC_RENDER_MAX_ATTEMPTS in
        // `services/llm-gateway/src/queue/` MUST stay aligned with `maxRetries` + 1 —
        // the consumer's ack-vs-retry decision is gated on that constant, and a
        // mismatch silently drops messages on the final attempt before the DLQ.
        const videoRenders = yield* VideoRenders;
        const videoRendersDlq = yield* VideoRendersDlq;
        const musicRenders = yield* MusicRenders;
        const musicRendersDlq = yield* MusicRendersDlq;

        yield* Cloudflare.Queues.Consumer("llm-gateway-video-renders-consumer", {
            deadLetterQueue: videoRendersDlq.queueName,
            queueId: videoRenders.queueId,
            scriptName: gateway.workerName,
            settings: {
                // One render per invocation — each render is heavy and we already get
                // parallelism via maxConcurrency.
                batchSize: 1,
                // Up to 10 concurrent render invocations cluster-wide. Each invocation
                // drives one provider HTTP call; cap reflects the provider rate budget
                // we're willing to spend.
                maxConcurrency: 10,
                // 2 retries on top of the initial delivery = 3 total attempts. After that, DLQ.
                maxRetries: 2,
                // Don't wait — flush each message immediately.
                maxWaitTimeMs: 1000,
                // 60s backoff matches the consumer's retry decision in queue/video-render-consumer.ts.
                retryDelay: 60,
            },
        });
        yield* Cloudflare.Queues.Consumer("llm-gateway-video-renders-dlq-consumer", {
            queueId: videoRendersDlq.queueId,
            scriptName: gateway.workerName,
            // DLQ is observed for logging, not retried. Use a small batch + low
            // concurrency since these are rare.
            settings: { batchSize: 10, maxConcurrency: 1, maxRetries: 0, maxWaitTimeMs: 30_000 },
        });
        yield* Cloudflare.Queues.Consumer("llm-gateway-music-renders-consumer", {
            deadLetterQueue: musicRendersDlq.queueName,
            queueId: musicRenders.queueId,
            scriptName: gateway.workerName,
            settings: {
                batchSize: 1,
                maxConcurrency: 10,
                maxRetries: 2,
                maxWaitTimeMs: 1000,
                // 30s backoff matches MUSIC_RENDER_RETRY_DELAY_SECONDS — music providers
                // usually clear transient failures faster than video.
                retryDelay: 30,
            },
        });
        yield* Cloudflare.Queues.Consumer("llm-gateway-music-renders-dlq-consumer", {
            queueId: musicRendersDlq.queueId,
            scriptName: gateway.workerName,
            settings: { batchSize: 10, maxConcurrency: 1, maxRetries: 0, maxWaitTimeMs: 30_000 },
        });

        for (const { dimensions, index } of embeddingIndexes) {
            const vectorIndex = yield* index;

            for (const propertyName of EMBEDDING_METADATA_PROPERTIES) {
                // The logical id is built from the dimensions: `vectorIndex.indexName` is an
                // Output, and in a template it would collapse every id to "[object Object]-…".
                yield* Cloudflare.Vectorize.MetadataIndex(`neore-embeddings-${dimensions}-${propertyName}`, {
                    indexName: vectorIndex.indexName,
                    indexType: "string",
                    propertyName,
                });
            }
        }

        const backend = yield* Cloudflare.Worker("neore-backend", {
            // Minified, React production builds, English-only zod locales — see
            // scripts/worker-bundle.ts. `wrangler.jsonc`'s `minify` does not reach this.
            build: BACKEND_BUILD,
            // See backend/wrangler.jsonc: `durable_object_io_tasks_prevent_eviction` keeps a
            // Durable Object alive for its pending I/O.
            // `global_fetch_strictly_public`: the jobs queue and the scheduler dispatch each
            // job to the backend's own public URL, which on workers.dev is a Worker of this
            // account (see `Website`); without the flag every dispatch was a 404 (1042) and
            // the guest-account merge after sign-up never ran.
            compatibility: { date: "2026-06-10", flags: ["nodejs_compat", "durable_object_io_tasks_prevent_eviction", "global_fetch_strictly_public"] },
            // Production only: a preview has no traffic to justify a tick every minute.
            crons: stage === "production" ? [...backendBindings.crons] : [],
            domain: customDomain(requireEnv("BACKEND_PUBLIC_ORIGIN"), "BACKEND_PUBLIC_ORIGIN"),
            env: {
                // First, so every explicit binding below overrides its pass-through
                // counterpart — `ENVIRONMENT`, `SITE_URL` and friends are derived here,
                // not copied from the deploy runner's environment.
                ...requiredEnvPassthrough,
                ...optionalEnvPassthrough,
                ...backendDurableObjects,
                ...backendWorkflows,
                DB: BackendDatabase,
                FILES: BackendFiles,
                // Producer bindings under the names codegen derives from the exports
                // (`queueBindingName`); the DLQ's is how `@lunora/queue` would re-send
                // a message — it is bound for every declared queue.
                QUEUE_JOBS: BackendJobs,
                QUEUE_JOBS_DEAD_LETTERS: BackendJobsDlq,
                LUNORA_ADMIN_TOKEN: secret(requireEnv("LUNORA_ADMIN_TOKEN")),
                NODE_ENV: stage === "production" ? "production" : "development",

                // Signing, encryption and the outbound services the backend cannot boot
                // without. `lib/env-validation.ts` is the full list; these are the ones
                // that were never bound at all.
                ADMIN: process.env.ADMIN ?? "",
                AUTH_SECRET: secret(requireEnv("BETTER_AUTH_SECRET")),
                BETTER_AUTH_SECRET: secret(requireEnv("BETTER_AUTH_SECRET")),
                ENCRYPTION_KEY: secret(requireEnv("ENCRYPTION_KEY")),
                ENVIRONMENT: stage === "production" ? "production" : "preview",
                // Empty in production. The backend strips it from the queue names it is
                // delivered (`backend/src/queue-stage.ts`).
                STAGE: stage === "production" ? "" : stage,
                JWKS: process.env.JWKS ?? "",
                // Verifies the gateway's calls back here and signs stream tokens. The
                // backend reaches the gateway itself over `SERVICE_LLM_GATEWAY` below.
                LLM_GATEWAY_SIGNING_SECRET: secret(requireEnv("LLM_GATEWAY_SIGNING_SECRET")),

                // The sibling Workers, as service bindings under the names Lunora
                // generates from `backend/lunora.config.ts` (`SERVICE_<KEY>`, also
                // written into backend/wrangler.jsonc `services[]`). No URL, no secret:
                // the three private ones have no other way in, and the gateway's
                // internal routes answer only its `InternalApi` entrypoint. Unbound, a
                // call fails naming the binding (`ctx.services.<key>`), and the optional
                // features (text extraction, NSFW check, browser tool) skip themselves.
                SERVICE_BROWSER_RENDERER: BrowserRenderer,
                SERVICE_DOCUMENT_PARSER: DocumentParser,
                SERVICE_LLM_GATEWAY: Cloudflare.WorkerEntrypoint(gateway, "InternalApi"),
                SERVICE_NSFW_CHECKER: NsfwChecker,
                // `MAIL_FROM` and Resend's key ride `requiredEnvPassthrough` above; only
                // the Email Service binding is decided here. See `email/mailer.ts`.
                ...(useEmailService ? { EMAIL: Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [mailFromAddress] }) } : {}),
                R2_ENDPOINT: requireEnv("R2_ENDPOINT"),
                SITE_URL: requireEnv("SITE_URL"),
                STORAGE_SIGNING_SECRET: secret(requireEnv("STORAGE_SIGNING_SECRET")),

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
                // Lunora's identity memo would otherwise reuse a resolved session for
                // better-auth's cookie-cache window (60 s), so a revoked session or a
                // changed role keeps authorising for that long. 0 = resolve per request.
                LUNORA_IDENTITY_CACHE_MS: "0",

                // Both halves. `auth.ts` loads the captcha plugin only when it has the
                // secret AND knows a site key exists, so binding one without the other
                // degrades to "no captcha" rather than locking every credential flow.
                // The guard above refuses to deploy in that state regardless.
                TURNSTILE_SECRET_KEY: turnstileSecret,
                TURNSTILE_SITE_KEY: turnstileSiteKey,
                ...Object.fromEntries(embeddingIndexes.map(({ dimensions, index }) => [`EMBEDDINGS_${dimensions}`, index])),
            },
            main: "./backend/src/server.ts",
            name: named("neore-backend"),
            observability: WORKER_OBSERVABILITY,
            placement: { mode: "smart" },
        });

        yield* Cloudflare.Queues.Consumer("neore-backend-jobs-consumer", {
            deadLetterQueue: (yield* BackendJobsDlq).queueName,
            queueId: (yield* BackendJobs).queueId,
            scriptName: backend.workerName,
            settings: { ...JOBS_QUEUE_CONSUMER, maxRetries: jobs.maxRetries, retryDelay: jobs.retryDelay },
        });
        yield* Cloudflare.Queues.Consumer("neore-backend-jobs-dlq-consumer", {
            queueId: (yield* BackendJobsDlq).queueId,
            scriptName: backend.workerName,
            // Observed for logging, not retried (`jobsDeadLetters` acks it).
            settings: { batchSize: 10, maxConcurrency: 1, maxRetries: jobsDeadLetters.maxRetries, maxWaitTimeMs: 30_000 },
        });

        // documentParser / nsfwChecker / browserRenderer: private (`workersDev: false`) —
        // reached only through the backend's service bindings. embeddings: private and
        // unbound.
        return {
            backend: backend.url,
            llmGateway: gateway.url,
            stage,
            website: website.url,
        };
    }),
);
