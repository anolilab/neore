// Lunora's structural binding types, not @cloudflare/workers-types': the app
// builder is declared against these, and the concrete Workers types are not
// assignable to them. Each lives in the add-on package that owns it.
import { handleAuthRequest } from "@lunora/auth";
import type { PaymentsFromContextOptions } from "@lunora/payment";
import { createCreemAdapter } from "@lunora/payment/creem";
import { Creem } from "creem";
import type { JSONWebKeySet } from "jose";
import type { D1DatabaseLike } from "@lunora/d1";
import type { MessageBatchLike, QueueBindingLike } from "@lunora/queue";
import type { DurableObjectNamespaceLike } from "@lunora/scheduler";
import type { R2BucketLike } from "@lunora/storage";
import type { ExecutionContextLike, ScheduledControllerLike, ShardNamespaceLike } from "lunorash/runtime";
import { d1Executor } from "@lunora/auth";

import { createJwksCache, type JwksCache } from "./jwks-cache.js";
import { inTimingFrame, installFetchTiming, isTimingEnabled, logTiming, timedD1 } from "./development-timing.js";
import { routedShardNamespace } from "../lunora/lib/shard-namespace.js";
import { posthogErrorSink } from "./posthog-sink.js";
import { defineApp } from "../lunora/_generated/app.js";
import { buildAuth } from "../lunora/auth.js";
import { ensureGlobalTables } from "../lunora/auth/lib/ensure-global-tables.js";
import httpApp, { getAllowedOrigins } from "../lunora/http.js";
import type { ApiKeyAuthApi } from "../lunora/public-api/identity.js";
import { isPublicApiPath, resolveApiKeyIdentity } from "../lunora/public-api/identity.js";
import { requestBearer, requestWsTicket } from "../lunora/lib/request-bearer.js";
import { handleWsTicketRequest, purgeExpiredWsTickets, redeemWsTicket } from "../lunora/lib/ws-ticket.js";
import { runInShard } from "../lunora/lib/shard-context.js";
import { shardScopedSchedulerNamespace } from "../lunora/lib/shard-scheduler.js";
import { createGrantLookup, createShardAuthorizer, isShardRoutedRequest, withCallerShard } from "./shard-routing.js";

interface Env {
    /**
     * better-auth's signing secret, required by `buildAuth(env)`.
     *
     * It was missing from this interface entirely — the worker's declared env did
     * not mention the one binding without which no session can be signed or
     * verified. Set it with `wrangler secret put AUTH_SECRET` (and in `.dev.vars`
     * locally); it is deliberately NOT optional, so a deploy without it fails to
     * type-check rather than failing every login at runtime.
     */
    AUTH_SECRET: string;
    /** Creem (`billing/`). Unset, checkout and the portal refuse before any call. */
    CREEM_API_KEY?: string;
    /** `true` targets test-api.creem.io (test-mode keys and products). */
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    DB: D1DatabaseLike;

    /**
     * The ten Vectorize indexes, one per embedding width.
     *
     * Declared here because `.vectors(...)` below needs them typed — they were
     * absent from this interface while the schema declared the indexes, which is
     * the same class of gap the `AUTH_SECRET` note above describes.
     */
    EMBEDDINGS_128: Vectorize;
    EMBEDDINGS_256: Vectorize;
    EMBEDDINGS_512: Vectorize;
    EMBEDDINGS_768: Vectorize;
    EMBEDDINGS_1024: Vectorize;
    EMBEDDINGS_1408: Vectorize;
    EMBEDDINGS_1536: Vectorize;
    EMBEDDINGS_2048: Vectorize;
    EMBEDDINGS_3072: Vectorize;
    EMBEDDINGS_4096: Vectorize;
    FILES: R2BucketLike;

    /**
     * Authenticates the jobs consumer's calls to `/_lunora/scheduler/dispatch`
     * (`lunora/queues.ts`; `@lunora/queue` sends it as a bearer). Unset, every
     * queued job fails and is retried into the DLQ.
     */
    LUNORA_ADMIN_TOKEN?: string;
    /** The origin the consumer dispatches back to — the same value the SchedulerDO uses. */
    LUNORA_ORIGIN_URL?: string;

    /** PostHog project key + ingestion host: server errors go to Error Tracking (`posthog-sink.ts`). */
    POSTHOG_API_KEY?: string;
    POSTHOG_HOST?: string;
    /**
     * This Worker's own public origin.
     *
     * NOT optional. It is the base for the JWKS URL that bearer tokens are
     * verified against, for signed storage URLs, and for the origin the scheduler
     * dispatches back to. Unset, the `?? ""` fallbacks it used to carry made all
     * three silently wrong — bearer verification would fail against an empty
     * origin and every RPC would come back FORBIDDEN_SHARD, which looks like an
     * auth bug rather than a missing binding.
     */
    PUBLIC_ORIGIN: string;

    /**
     * The jobs queue and its DLQ (`lunora/queues.ts`, `lib/job-queue.ts`):
     * agent runs, task rounds, eval cases and coding-agent steps, dispatched
     * concurrently by the generated `queue()` consumer instead of through the
     * SchedulerDO's alarm (at most six in flight).
     */
    QUEUE_JOBS: QueueBindingLike;
    QUEUE_JOBS_DEAD_LETTERS: QueueBindingLike;

    SCHEDULER: DurableObjectNamespaceLike & ShardNamespaceLike;

    SHARD: ShardNamespaceLike;
    /** `ShardRegistryDO` — which user shards exist, for cross-shard fan-out (`.shardRegistry` below). */
    SHARD_REGISTRY: ShardNamespaceLike;
    /** DEV-ONLY: `off` pins every shard key to `__root__` (`lib/shard-namespace.ts`). */
    SHARD_ROUTING?: string;
    /** DEV-ONLY: `on` logs `[timing]` lines (`src/development-timing.ts`). */
    SHARD_TIMING?: string;
    STORAGE_SIGNING_SECRET?: string;
}

/**
 * Worker entry for the Lunora backend.
 *
 * NOTE on shard authorization: unlike the Lunora templates we do NOT set
 * `allowUnauthenticatedShardAccess`. Every sharded table in this app is keyed by
 * a tenant-ish value (`userId` / `threadId`), so an open shard router would let
 * any authenticated caller address any other user's Durable Object. `authorizeShard`
 * below is the gate; it runs before the DO is reached.
 */

/**
 * This Worker's public origin, or a loud failure.
 *
 * A `workers.dev` URL is `<worker>.<account-subdomain>.workers.dev`; a
 * single-label guess like `neore-backend.workers.dev` resolves to nothing. That
 * is exactly what was configured, so the JWKS fetch could never have succeeded
 * in production — and the empty-string fallbacks meant nothing said so.
 */
const requirePublicOrigin = (env: Env): string => {
    const origin = env.PUBLIC_ORIGIN?.trim();

    if (!origin) {
        throw new Error("PUBLIC_ORIGIN is not set — bearer verification, signed storage URLs and scheduler dispatch all resolve against it.");
    }

    return origin;
};

/** Every outbound Creem call holds the shard it runs on while it waits, so it gets a deadline. */
const CREEM_TIMEOUT_MS = 10_000;

let payments: PaymentsFromContextOptions | undefined;

/**
 * Backs `ctx.payments`, built once per isolate. It must not throw when Creem is
 * not configured: billing procedures report that themselves.
 *
 * `authorize` is Lunora's default — the reference must be the caller's own user
 * id — so the facade can never act on someone else's billing. Every call that
 * needs more goes to `ctx.payments.adapter` behind its own check:
 * `billing/checkout.ts` (Team: `billingOrganizationOf`, portal:
 * `portalCustomerFor`) and the GDPR deletion step (`billing/gdpr.ts`).
 */
const creemPayments = (env: Env): PaymentsFromContextOptions => {
    payments ??= {
        adapter: createCreemAdapter({
            client: new Creem({
                apiKey: env.CREEM_API_KEY ?? "",
                server: env.CREEM_TEST_MODE === "true" ? "test" : "prod",
                timeoutMs: CREEM_TIMEOUT_MS,
            }),
            webhookSecret: env.CREEM_WEBHOOK_SECRET ?? "",
        }),
    };

    return payments;
};

let jwksCache: JwksCache | undefined;
let grantLookup: ReturnType<typeof createGrantLookup> | undefined;

/** The per-isolate grant lookup behind `authorizeShard` (`./shard-routing.ts`). */
const grantLookupFor = (env: Env): ReturnType<typeof createGrantLookup> => {
    grantLookup ??= createGrantLookup(env.DB);

    return grantLookup;
};

type CallerIdentity = null | { [claim: string]: unknown; userId: string };

/**
 * Identities `fetch` resolved while routing a request to the caller's shard,
 * keyed by the request it handed the runtime, so `resolveIdentity` reuses them.
 */
const routedIdentities = new WeakMap<Request, CallerIdentity>();

/**
 * Our own JWKS, read IN PROCESS from better-auth rather than fetched from
 * `/api/auth/jwks`.
 *
 * It used to be `createRemoteJWKSet(origin + "/api/auth/jwks")`: every isolate's
 * first bearer check made this Worker fetch ITSELF. In `wrangler dev` that is
 * loopback traffic through wrangler's ProxyWorker, which took ~5s under a
 * first-paint burst — right at jose's 5s fetch timeout — and a request that
 * lost that race fell through to "anonymous" (a spurious 401) while the aborted
 * self-fetch fed wrangler's fatal "Network connection lost". Deployed, it was
 * a subrequest per cold isolate for data the Worker already holds.
 *
 * A token signed by a key minted after the cache was filled (rotation) fails
 * once, then verifies against a fresh set — at most one such re-read per
 * isolate every 30s (`src/jwks-cache.ts`).
 */
const verifyBearer = async (env: Env, token: string, origin: string) => {
    jwksCache ??= createJwksCache(async () => await (buildAuth(env).api as unknown as { getJwks: () => Promise<JSONWebKeySet> }).getJwks());

    return await jwksCache.verify(token, { audience: origin, issuer: origin });
};

/**
 * The caller's session identity: a verified bearer JWT, else the cookie session.
 * Shared by `resolveIdentity` and the ws-ticket mint, which must accept exactly
 * the callers RPC accepts.
 */
const resolveSessionIdentity = async (env: Env, request: Request): Promise<null | { sessionId?: string; userId: string }> => {
    // Bearer first, deliberately. The browser's `LunoraClient`
    // authenticates with the JWT from `/api/auth/token`, so on the RPC
    // path — the hottest path in the app — a cookie lookup would be a
    // guaranteed database miss before the token that was always going
    // to answer.
    //
    // The token is VERIFIED against our own JWKS, never merely decoded:
    // `sub` is a user id, and trusting it unchecked would let any caller
    // assert any identity and, through `authorizeShard` below, address
    // any user's Durable Object.
    // Header only — never the URL (`lib/request-bearer.ts`).
    const bearer = requestBearer(request);

    if (bearer !== undefined) {
        try {
            const origin = requirePublicOrigin(env);
            // `iss`/`aud` are pinned, not just the signature. Both are
            // issued as this Worker's own origin (verified against a
            // live token), so requiring them costs nothing today and
            // means a token minted for some other audience cannot be
            // replayed here if the key set is ever shared.
            const { payload } = await verifyBearer(env, bearer, origin);

            if (typeof payload.sub === "string") {
                // `sessionId` is what `getSession(ctx)` reads back
                // (`lunora/auth/session.ts`); a token minted before
                // `sid` was added simply carries none.
                return { userId: payload.sub, ...(typeof payload.sid === "string" && { sessionId: payload.sid }) };
            }
        } catch {
            // Expired, wrong signature, unreachable JWKS — fall through
            // to the cookie rather than assuming anonymous, so a stale
            // bearer does not mask a valid same-origin session.
        }
    }

    // Cookie-borne session: same-origin calls and SSR carry it.
    const session = await buildAuth(env).api.getSession({ headers: request.headers });

    return session?.user?.id ? { sessionId: session.session.id, userId: session.user.id } : null;
};

/**
 * Who the caller is, for every RPC (see `resolveIdentity` below): an API key on
 * `/api/v1/*`, a live-query ticket, else the session (bearer, then cookie).
 */
const resolveCallerIdentity = async (env: Env, request: Request): Promise<CallerIdentity> => {
    // The public v1 API authenticates with API keys ONLY, and API keys
    // authenticate nothing else. Neither the bearer JWT nor the cookie
    // below is consulted on this path, and a key presented anywhere
    // else is ignored — so a key can never reach `/_lunora/rpc`,
    // where no scope check runs. See `public-api/identity.ts`.
    if (isPublicApiPath(new URL(request.url).pathname)) {
        return await resolveApiKeyIdentity(request, async (key) => await (buildAuth(env).api as unknown as ApiKeyAuthApi).verifyApiKey({ body: { key } }));
    }

    // The live-query socket's upgrade carries a single-use ticket
    // instead of a bearer (`lib/ws-ticket.ts`): a browser cannot set
    // headers on a `WebSocket`, and the URL is logged. A spent,
    // expired or forged ticket falls through to the cookie, like a
    // stale bearer does.
    const ticket = requestWsTicket(request);

    if (ticket !== undefined) {
        const identity = await redeemWsTicket(env.DB, ticket);

        if (identity) {
            return { ...identity };
        }
    }

    return await resolveSessionIdentity(env, request);
};

const app = defineApp<Env>()
    .shard((env) => routedShardNamespace(env.SHARD, env))
    /**
     * Cross-shard fan-out. Without a registry, ANY request carrying `fanOut` is
     * rejected 400 — `admin/import`, `admin/export`, cross-shard `rank()` /
     * `rankPage()`, and reverse-relation reads. The symptom that found it:
     *
     *   {"error":{"code":"BAD_REQUEST",
     *     "message":"Import endpoint requires a `queryCoordinator` on the worker"}}
     *
     * Every sharded table here is `.shardBy("userId")` — 54 of them — so the key
     * set is "every user that exists", which grows with signups and is exactly
     * the data a fan-out wants to reach. Declaring the registry does both halves:
     * each shard registers its key in `ShardRegistryDO` on its first write to a
     * `.shardBy()` table, and the worker's `queryCoordinator` fans out to the
     * keys it lists (30s cache).
     *
     * Its own namespace, not `routedShardNamespace`: the registry is ONE
     * instance by name, and dev's `SHARD_ROUTING=off` pin applies to user shards.
     */
    .shardRegistry((env) => env.SHARD_REGISTRY)
    // `.global()` tables (better-auth identity/org + the cross-user catalogs)
    // live in D1. Without this the router has nowhere to send them and `ctx.db`
    // reads on those tables fail at runtime.
    .global({ d1: (env) => (isTimingEnabled(env) ? timedD1(env.DB) : env.DB), origin: (env) => requirePublicOrigin(env) })
    // Backs `ctx.storage`. Declaring
    // it is what types `ctx.storage`; installing @lunora/storage alone leaves it
    // `unknown`, which surfaced as ~28 "is of type unknown" errors.
    .storage({
        bucket: (env) => env.FILES,
        publicBaseUrl: (env) => requirePublicOrigin(env),
        signingSecret: (env) => env.STORAGE_SIGNING_SECRET ?? "",
    })
    // Backs `ctx.scheduler.runAfter/runAt` and the 8 ported crons.
    //
    // No `origin` here: the SchedulerDO reads `LUNORA_ORIGIN_URL` from its own
    // env at fire time, deliberately, so a forged `originUrl` in a dispatch body
    // cannot redirect the callback. This declaration used to accept an `origin`
    // that went nowhere — configuring it looked sufficient while every
    // `runAfter/runAt` failed with "LUNORA_ORIGIN_URL env binding must be set on
    // the SchedulerDO". Resolved upstream by dropping the option, so the binding
    // is now the only place to set it:
    // `.dev.vars` via `scripts/dev-setup.js` for dev, `alchemy.run.ts` for deploys.
    //
    // The binding is wrapped (`lib/shard-scheduler.ts`): a job scheduled from a
    // user's shard defaults its `shardKey` to that shard — without it every job
    // ran on `__root__`, where none of the user's rows are — and goes to that
    // user's own SchedulerDO instance rather than the single app-wide one, whose
    // alarm keeps at most six jobs in flight for everyone (anolilab/lunora#793).
    .scheduler({ namespace: (env) => shardScopedSchedulerNamespace(env.SCHEDULER) })
    .payment(creemPayments)
    /**
     * The ten Vectorize indexes backing `ctx.vectors`.
     *
     * Required whenever the schema declares vector indexes. Omitting it makes
     * `ctx.vectors` a throwing stub and `buildWorkerOptions` reject EVERY
     * request, `/_lunora/health` included — that is how it shipped once already.
     *
     * `lunora verify` / `build` / `deploy` catch it. The cli@242 check was a TEXT
     * SEARCH for `.vectors(`, so this very comment disarmed it — delete the call,
     * keep the prose, and `verify` exited 0 (anolilab/lunora#674). Fixed in
     * cli@245: the gate now reads the chain on `defineApp()`, and re-testing that
     * exact edit on 2026-09-11 — call gone, comment kept, two literal
     * `.vectors(` still in the file — exits 1 naming all ten indexes.
     *
     * Keys are the schema's index names (`embeddings-<dim>`, mirrored in
     * `_generated/vectors.ts`); values are the wrangler bindings. The two must
     * agree with `wrangler.jsonc`'s `index_name`, which is the same coupling the
     * vectorize block there already documents.
     */
    .vectors((env) => {
        return {
            "embeddings-128": env.EMBEDDINGS_128,
            "embeddings-256": env.EMBEDDINGS_256,
            "embeddings-512": env.EMBEDDINGS_512,
            "embeddings-768": env.EMBEDDINGS_768,
            "embeddings-1024": env.EMBEDDINGS_1024,
            "embeddings-1408": env.EMBEDDINGS_1408,
            "embeddings-1536": env.EMBEDDINGS_1536,
            "embeddings-2048": env.EMBEDDINGS_2048,
            "embeddings-3072": env.EMBEDDINGS_3072,
            "embeddings-4096": env.EMBEDDINGS_4096,
        };
    })
    // The 20 webhook/streaming endpoints in `lunora/http.ts`, mounted ahead of
    // Lunora's own routes. This used to go in through `.extend` (typed
    // `Partial<WorkerOptions>`) because the generated builder had only
    // `.route(key, handler)` for one-off handlers; it grew `.httpRouter(app)`,
    // which is the declared seam for a whole hono app with its own CORS and
    // error handling.
    .httpRouter(httpApp)
    // Shard half of error reporting: `ctx.log.error` lines (`posthog-sink.ts`).
    .observability((env) => posthogErrorSink(env))
    .extend((env) => {
        return {
            /**
             * Who the caller is, for every RPC.
             *
             * `defineApp`'s `.auth(...)` normally wires this, but this app does not
             * use it — that helper also runs `ensureMigrated`, which drives
             * better-auth's migrator, unsupported by the Lunora D1 adapter and
             * fatal (`process.exit`) inside the isolate. Auth is mounted by hand in
             * `fetch` below instead.
             *
             * Nothing was then supplying `resolveIdentity`, so identity was `null`
             * on every request, `authorizeShard` (just below) failed closed, and
             * EVERY `_lunora/rpc` call came back `FORBIDDEN_SHARD` — the thread
             * list never loaded and the chat route bounced to sign-in.
             */

            /**
             * `shardKey` is `__root__` or a user id — every sharded table is
             * `.shardBy("userId")` and requests route to the owner's shard
             * (`withCallerShard` below). The rule lives in `./shard-routing.ts`:
             * root is open, a user shard admits its owner and anyone the owner
             * granted a thread or page (a `.global()` grant row, cached 30s).
             *
             * If a table is ever sharded by something that is not a user id, this
             * has to learn about it — it would otherwise reject that shard for
             * everyone.
             */
            // Takes ONE `ShardCaller` since @lunora/runtime alpha.75 — it was
            // `(identity, shardKey)`. Same two values, same rule; only the shape moved.
            authorizeShard: createShardAuthorizer(grantLookupFor(env)),
            // Worker half of error reporting: failed RPCs. Same sink as `.observability` above.
            observability: posthogErrorSink(env),
            resolveIdentity: async (request: Request): Promise<null | { [claim: string]: unknown; userId: string }> => {
                // Already resolved by `fetch` to pick the default shard — and a
                // live-query ticket is single-use, so resolving twice would fail.
                const routed = routedIdentities.get(request);

                if (routed !== undefined) {
                    return routed;
                }

                return await resolveCallerIdentity(env, request);
            },
        };
    })
    .build();

/**
 * The shard Durable Object, re-exported under the `class_name` wrangler binds.
 *
 * This used to be a subclass that hand-implemented `runShardImport`, because the
 * base `ShardDO` shipped it (and `runShardExport`) as success-shaped stubs —
 * `{conflicts:0,errors:[],inserted:{}}` and `[]` — that codegen overrode
 * neither. An `admin/import` against any `.shardBy()` table therefore returned
 * 200 and wrote nothing. Codegen now emits both, inserting with
 * `allowExplicitId` so a source database's `_id`s carry across verbatim, which
 * is what keeps every cross-tier foreign key valid without a remapping pass.
 */
/**
 * …and every entry point runs inside the shard's own ALS context
 * (`lib/shard-context.ts`), so work it hands off — `ctx.scheduler` jobs,
 * `enqueueJob` — defaults to THIS shard instead of `__root__`. The key is the
 * DO's name (`ctx.id.name`), which is what the runtime resolved to reach it.
 *
 * `abstract` for the type checker only: `createShardDO` is typed as returning
 * the abstract base, whose `handleRpc` the generated class implements at
 * runtime. JavaScript has no abstract classes, so wrangler instantiates this
 * like any other.
 */
type TimingEnvLike = Parameters<typeof isTimingEnabled>[0];

export abstract class ShardDO extends app.ShardDO {
    /** Requests currently inside this DO's `fetch` — reported by `SHARD_TIMING`. */
    private inFlight = 0;

    public override async fetch(request: Request): Promise<Response> {
        const shardKey = this.shardKeyForContext();

        if (!isTimingEnabled((this as unknown as { env?: TimingEnvLike }).env ?? {})) {
            return await runInShard(shardKey, async () => await super.fetch(request));
        }

        installFetchTiming();

        const started = Date.now();
        const ahead = this.inFlight;

        this.inFlight += 1;

        try {
            return await inTimingFrame(`do:${new URL(request.url).pathname}`, async () => await runInShard(shardKey, async () => await super.fetch(request)));
        } finally {
            this.inFlight -= 1;
            logTiming("do", { ahead, ms: Date.now() - started, path: new URL(request.url).pathname, shard: shardKey === "__root__" ? "root" : "user" });
        }
    }

    public override async alarm(): Promise<void> {
        await runInShard(this.shardKeyForContext(), async () => {
            await super.alarm();
        });
    }

    public override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        await runInShard(this.shardKeyForContext(), async () => {
            await super.webSocketMessage(ws, message);
        });
    }

    public override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await runInShard(this.shardKeyForContext(), async () => {
            await super.webSocketClose(ws, code, reason, wasClean);
        });
    }

    public override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        await runInShard(this.shardKeyForContext(), async () => {
            await super.webSocketError(ws, error);
        });
    }

    private shardKeyForContext(): string {
        return this.currentShardKey();
    }
}

/**
 * The `ShardRegistryDO` behind `.shardRegistry(...)` above, bound as
 * `SHARD_REGISTRY` — exported for the same reason as `SchedulerDO` below.
 */
export { ShardRegistryDO } from "../lunora/_generated/shardRegistry.js";

// Wrangler requires every `workflows[].class_name` to be EXPORTED by the worker
// entry, or the binding cannot be provisioned. Without this, `lunora prepare`
// warns that `accountDeletionWorkflow`, `chatImportWorkflow` and
// `dataExportWorkflow` are declared but unreachable — which would have shipped a
// deploy where GDPR export, account deletion and chat import silently have no
// workflow to run.
export * from "../lunora/_generated/workflows.js";

/**
 * `.scheduler({ namespace, origin })` above wires the BINDING; it does not export
 * the class. Wrangler requires every `durable_objects.bindings[].class_name` to
 * be exported by the worker entry, so without this line the bundle is rejected:
 *
 *   Your Worker depends on the following Durable Objects, which are not
 *   exported in your entrypoint file: SchedulerDO.
 *
 * That would have taken down `ctx.scheduler.runAfter/runAt` wholesale — the
 * `deleteUnusedFiles` / `deleteExpiredTemporaryChats` / `vacuumDocumentHistory`
 * cron continuations, background memory extraction after each AI response, and
 * every other `scheduleAfter` in the tree.
 *
 * `lunora verify` catches this as of cli@245 — it names the class and this file
 * and exits 1. It used to report "project is valid" instead and leave the catch
 * to `lunora build` alone (anolilab/lunora#652, re-tested 2026-09-11 on the
 * literal edit: comment out the line below and `verify` exits 1).
 *
 * Codegen also emits `_generated/scheduler.ts`, which re-exports the same class
 * for an entry that would rather forward a module than name the package. Either
 * satisfies wrangler; do not do both, or the entry has a duplicate export.
 */
export { SchedulerDO } from "@lunora/scheduler";

/**
 * Send an RPC or live-query socket that names no shard to the caller's own
 * (`./shard-routing.ts`). The identity resolved for that is handed to
 * `resolveIdentity` through {@link routedIdentities}, so it is not resolved
 * twice — which a single-use socket ticket could not survive anyway. A caller
 * with no identity stays on `__root__`.
 */
const routeToCallerShard = async (env: Env, request: Request): Promise<Request> => {
    if (!isShardRoutedRequest(request)) {
        return request;
    }

    const identity = await resolveCallerIdentity(env, request);
    const routed = await withCallerShard(request, identity?.userId);

    routedIdentities.set(routed, identity);

    return routed;
};

/**
 * Reflect the request's origin onto a response when it is allowed.
 *
 * Reuses `lunora/http.ts`'s allowlist so there is one definition of "allowed
 * origin" rather than two that can drift. Never a wildcard: these responses
 * carry credentials.
 */
const withCors = (response: Response, request: Request): Response => {
    // A WebSocket upgrade must be handed back untouched.
    //
    // The rebuild at the end of this function is fatal for one: `new Response(
    // body, { status: 101 })` is not constructible in workerd, and even if it
    // were, it would drop the `webSocket` handle that carries the server end of
    // the socket. The throw surfaces to the client as
    //
    //   WebSocket connection to 'ws://…/_lunora/ws' failed: Error during
    //   WebSocket handshake: Unexpected response code: 500
    //
    // and — because the rebuild only happens for origins that PASS
    // `getAllowedOrigins()` — it inverted this helper's purpose exactly:
    //
    //   http://localhost:5173     allowed      -> 500
    //   chrome-extension://…      allowed      -> 500
    //   http://localhost:9999     not allowed  -> 101   (early return above,
    //   https://evil.example.com  not allowed  -> 101    so never rebuilt)
    //
    // So the web app and the browser extension were the only clients that could
    // NOT open a subscription, and fell back to polling — a single authenticated
    // first paint issued 96 RPCs. Nothing is lost by skipping: browsers do not
    // apply CORS to the WebSocket handshake, which has its own origin model, and
    // the upgrade is gated by `LUNORA_ALLOWED_ORIGINS` plus the RPC auth checks.
    if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) {
        return response;
    }

    const origin = request.headers.get("Origin");

    if (!origin) {
        return response;
    }

    const allowed = getAllowedOrigins()(origin);

    if (!allowed) {
        return response;
    }

    const headers = new Headers(response.headers);

    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");

    if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        headers.set("Access-Control-Allow-Headers", request.headers.get("Access-Control-Request-Headers") ?? "Content-Type,Authorization");
        headers.set("Access-Control-Max-Age", "86400");
    }

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        const entered = Date.now();

        // better-auth owns `/api/auth/*`. It must be handled BEFORE the Lunora
        // worker, which would otherwise 404 those paths — Lunora only routes its
        // own RPC surface. This is the `mountAuth` step from the
        // `lunora-setup-auth` skill.
        // Preflight, answered BEFORE anything else.
        //
        // Neither of the two downstream handlers does CORS: `handleAuthRequest`
        // answers `OPTIONS /api/auth/*` with 404, and the generated app answers
        // `OPTIONS /_lunora/rpc` with 405. A preflight must be 2xx or the browser
        // rejects it — "Response to preflight request doesn't pass access control
        // check: It does not have HTTP ok status" — no matter how correct the
        // headers are. `lunora/http.ts` installs `cors()`, but that middleware
        // only sees the routes its own `httpRouter` declares.
        //
        // Not dev-only: the deployed app and backend are separate Workers on
        // separate origins, so the same preflight happens in production.
        if (request.method === "OPTIONS") {
            const preflight = withCors(new Response(null, { status: 204 }), request);

            if (preflight.headers.has("access-control-allow-origin")) {
                return preflight;
            }
        }

        // `lunora dev`'s readiness probe, answered before any setup below —
        // the same `{ ok: true }` the runtime's own handler returns. The probe
        // aborts after 1s and retries every 250ms; behind `ensureGlobalTables`
        // (a D1 round trip that queues under load) it routinely took 1-8s, so
        // each probe was abandoned and its response later written to a closed
        // socket. That is miniflare's "Network connection lost." — fatal to
        // wrangler 4.124 — and since every restart probes again under the same
        // load, a single crash became a crash loop.
        if (new URL(request.url).pathname === "/_lunora/status" && (request.method === "GET" || request.method === "HEAD")) {
            return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
        }

        // `.global()` tables are created lazily on first ORM access, and the auth
        // store bypasses the ORM entirely — so on a database that has never
        // served an ORM read, better-auth's first statement fails with
        // `no such table: rateLimit`. That is every `/api/auth/*` route, since
        // its durable rate limiter runs before each handler, and it never
        // self-heals. Memoised per isolate; see the helper for the full account.
        //
        // It must run BEFORE `buildAuth`: the D1 adapter checks the schema when
        // the auth instance is built and caches a failure for the isolate, so
        // on a fresh database the first isolate failed every auth request
        // (`SchemaMismatchError`, all tables missing) until it was recycled,
        // even though this call then created the tables.
        await ensureGlobalTables(d1Executor(env.DB));

        const auth = buildAuth(env);

        // `ensureMigrated(auth)` used to run here, on EVERY request. It is both
        // redundant and fatal:
        //
        //   - Redundant: better-auth's tables (`user`, `session`, `account`,
        //     `verification`, `twoFactor`) are all declared in `lunora/schema.ts`.
        //     Lunora owns their shape; better-auth has nothing left to create.
        //     (Half right — see `ensureGlobalTables` below. Lunora owns the
        //     shape, but on a fresh database nothing had CREATED the tables.)
        //   - Fatal: it drives better-auth's migration path, which does not
        //     support the Lunora D1 adapter —
        //
        //       ERROR [Better Auth]: Only kysely adapter is supported for
        //       migrations.
        //       Uncaught Error: The Node.js process.exit(1) API was called.
        //
        //     `process.exit` kills the isolate, so the worker answered exactly
        //     one request (with a 500) and then stopped serving. Every route,
        //     not just `/api/auth/*`, because this ran before the router.
        //
        // Invisible to `lunora build` and `lunora verify` — neither executes a
        // request. Only `lunora dev` shows it.

        const authResponse = await handleAuthRequest(auth, request);

        if (authResponse) {
            return withCors(authResponse, request);
        }

        // Minted here rather than as a procedure: `resolveIdentity` redeems the
        // ticket before any procedure runs, so both halves share one raw table.
        const ticketResponse = await handleWsTicketRequest(request, env.DB, async (ticketRequest) => await resolveSessionIdentity(env, ticketRequest));

        if (ticketResponse) {
            return withCors(ticketResponse, request);
        }

        if (!isTimingEnabled(env)) {
            return withCors(await app.fetch(await routeToCallerShard(env, request), env, context), request);
        }

        installFetchTiming();

        const path = new URL(request.url).pathname;

        return await inTimingFrame(`worker:${path}`, async () => {
            const routed = await routeToCallerShard(env, request);
            const routeMs = Date.now() - entered;

            try {
                return withCors(await app.fetch(routed, env, context), request);
            } finally {
                logTiming("worker", { method: request.method, ms: Date.now() - entered, path, routeMs });
            }
        });
    },

    /**
     * Queue consumers: `jobs` and its DLQ, declared in `lunora/queues.ts` and
     * dispatched by the generated handler. A preview deploy's `-preview` queue
     * names reach the same handlers through the `env.preview` producers in
     * `wrangler.jsonc`, which codegen reads as routing aliases.
     */
    async queue(batch: MessageBatchLike, env: Env, context: ExecutionContextLike): Promise<void> {
        await app.queue?.(batch, env, context);
    },

    /**
     * Cron triggers. The generated app dispatches `controller.cron` against the
     * crons registered in `lunora/crons.ts` — today ONE one-minute tick
     * (`cronTick`) that runs every periodic job when due.
     *
     * This handler was missing: the default export had only `fetch` (and later
     * `queue`), so no cron ever reached the app in a deployed Worker — trigger
     * schedules, stream cleanup, the task sweep, file and export retention and
     * the GDPR request timeouts all silently never ran. `wrangler dev` does not
     * fire crons on its own, which is how it went unnoticed; exercise it with
     * `curl "localhost:8788/cdn-cgi/local/scheduled?cron=%2A%2F1+%2A+%2A+%2A+%2A"` (the
     * path `wrangler dev` itself prints).
     */
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        // Here, not in `crons.ts`: the ws-ticket table is raw D1 that procedures
        // cannot reach (`lib/ws-ticket.ts`). A failure must not cost the tick.
        await purgeExpiredWsTickets(env.DB).catch((error: unknown) => {
            console.error("[ws-ticket] purge failed", error);
        });
        await app.scheduled(controller, env, context);
    },
};
