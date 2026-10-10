// Lunora's `httpRouter()` returns a hono app that is already wired to lift the
// runtime-injected per-request `HttpActionCtx` onto `c.var.lunora`. The action
// context is `c.var.lunora`; `c.env` is the Worker env.
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { httpAction, httpRouter } from "lunorash/server";

import {
    authorizeExtensionHttpAction,
    exchangeExtensionCodeHttpAction,
    extensionAccessTokenHttpAction,
    revokeExtensionSessionHttpAction,
} from "./auth/extension-grant-http";
import { E2E_INVITATIONS_PATH, e2eSeedInvitationHttpAction } from "./auth/e2e-seed-http";
import { seedInvitationsHttpAction } from "./auth/seed-invitations-http";
import {
    chatStartHttpAction,
    editMessageHttpAction,
    improvePromptHttpAction,
    iteratePromptHttpAction,
    mediaGenerationHttpAction,
    optimizeSystemPromptHttpAction,
} from "./chat/http";
import { gatewayUsageReportHttpAction } from "./chat/lib/gateway-usage";
import { callMCPToolFromAppHttpAction, readMCPResourceHttpAction } from "./chat/lib/mcp-apps";
import { getChunksHttpAction } from "./chat/streaming/persistent/http-api";
import { handleCreemWebhook } from "./billing/webhook";
import { handleResendWebhook } from "./email/webhook";
import { ENVIRONMENT, PUBLIC_ORIGIN, SITE_URL, TRUSTED_EXTENSION_ORIGINS, TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY } from "./env";
import { assertEnv } from "./lib/env-validation";
import { parseTrustedExtensionOrigins } from "./lib/extension-origins";
import pailLogger from "./lib/hono-logger";
import { handleSignedGet } from "./lib/signed-storage";
import { handleUploadRequest, TUS_REQUEST_HEADERS, TUS_RESPONSE_HEADERS, UPLOAD_PATH } from "./lib/upload-route";
import { httpLogger } from "./lib/logger";
import {
    handleDiscordWebhook,
    handleFeishuWebhook,
    handleLineWebhook,
    handleSlackWebhook,
    handleTeamsWebhook,
    handleTelegramWebhook,
    handleWeChatVerification,
    handleWeChatWebhook,
    handleWhatsAppVerification,
    handleWhatsAppWebhook,
} from "./messenger/webhooks";
import { onCallerShard, onRoutedShard, onThreadShard } from "./lib/http-shard";
import optimizePromptHttpAction from "./prompts/http";
import { PUBLIC_API_PREFIX } from "./public-api/identity";
import { createPublicApiRouter, publicApiUploadGate } from "./public-api/router";
import handleTriggerWebhook from "./triggers/http";
import streamWorkflowHttpAction from "./workflow/http";

const app = httpRouter();

// Strict env validation on first request per cold start; throws if a required var
// is missing or malformed so misconfigured deployments fail fast instead of leaking
// undefined values into auth/storage paths.
app.use("*", async (_c, next) => {
    assertEnv();
    await next();
});

if (ENVIRONMENT === "development") {
    app.use("*", pailLogger());
}

app.use("*", requestId());
// Build allowed origins based on environment
export const getAllowedOrigins = (): ((origin: string) => string | null) => {
    const staticOrigins: string[] = [];

    // In development, allow explicit local origins (never use wildcard with credentials)
    if (ENVIRONMENT === "development") {
        staticOrigins.push("http://localhost:3005", "http://localhost:5173", "http://localhost:4173");
    }

    if (SITE_URL) {
        staticOrigins.push(SITE_URL);

        // Also allow www subdomain if it's not already included
        if (!SITE_URL.includes("www.")) {
            const url = new URL(SITE_URL);

            staticOrigins.push(`${url.protocol}//www.${url.host}`);
        }
    }

    // This Worker's own origin. Same-origin requests carry no `Origin` header, so
    // this is for the cases that do: the browser extension's fetches and anything
    // hitting an HTTP route directly rather than through the app's proxy.
    if (PUBLIC_ORIGIN) {
        staticOrigins.push(PUBLIC_ORIGIN);
    }

    // Only the extension ids we ship — the same list `auth.ts` trusts. This used
    // to reflect ANY `chrome-extension://` origin, and with `credentials: true`
    // that let every extension the user has installed read credentialed
    // responses. An unset var allows none.
    staticOrigins.push(...parseTrustedExtensionOrigins(TRUSTED_EXTENSION_ORIGINS));

    return (origin: string) => (staticOrigins.includes(origin) ? origin : null);
};

app.use(
    "*",
    cors({
        allowHeaders: ["Authorization", "Content-Type", "Better-Auth-Cookie", "x-captcha-response", ...TUS_REQUEST_HEADERS],
        allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
        credentials: true,
        exposeHeaders: ["Content-Length", "Set-Better-Auth-Cookie", ...TUS_RESPONSE_HEADERS],
        maxAge: 600,
        origin: getAllowedOrigins(),
    }),
);

// Session-authenticated routes run on the caller's own shard, where their rows
// live (`lib/http-shard.ts`); `/chat/start`, `/chat/edit` and `/chat/media`
// re-route to a shared thread's owner.
app.post("/chat/media", httpAction(onThreadShard(mediaGenerationHttpAction)));
app.post("/chat/edit", httpAction(onThreadShard(editMessageHttpAction)));
app.post("/chat/improve-prompt", httpAction(onCallerShard(improvePromptHttpAction)));
app.post("/chat/optimize-system-prompt", httpAction(onCallerShard(optimizeSystemPromptHttpAction)));
app.post("/chat/iterate-prompt", httpAction(onCallerShard(iteratePromptHttpAction)));
app.post("/prompts/optimize", httpAction(onCallerShard(optimizePromptHttpAction)));
app.post("/workflow/stream", httpAction(onCallerShard(streamWorkflowHttpAction)));

// MCP Apps proxy endpoints — fetch ui:// resources and call tools on behalf of the browser
// Auth headers stay server-side; the client authenticates via session cookie
app.post("/mcp/resource", httpAction(onCallerShard(readMCPResourceHttpAction)));
app.post("/mcp/tool", httpAction(onCallerShard(callMCPToolFromAppHttpAction)));
app.post("/email/resend/webhook", httpAction(handleResendWebhook));
app.post("/billing/creem/webhook", httpAction(handleCreemWebhook));

// Messenger platform webhooks (no CORS/auth — platform-signed requests). Each
// runs on the connection owner's shard, found through `shardRoutes`.
// Per-connection URLs: /messenger/{platform}/{connectionId} for BYOK token lookup
app.post(
    "/messenger/telegram/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleTelegramWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/slack/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleSlackWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/discord/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleDiscordWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.get(
    "/messenger/whatsapp/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleWhatsAppVerification(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/whatsapp/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleWhatsAppWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/line/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleLineWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/feishu/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleFeishuWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/teams/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleTeamsWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.get(
    "/messenger/wechat/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleWeChatVerification(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);
app.post(
    "/messenger/wechat/:connectionId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "messenger",
            c.req.param("connectionId"),
            async (ctx) => await handleWeChatWebhook(ctx, c.req.raw, c.req.param("connectionId")),
        ),
);

// Trigger webhooks (no CORS/auth — signature-verified requests)
app.post(
    "/triggers/webhook/:triggerId",
    async (c) =>
        await onRoutedShard(
            c.var.lunora,
            "trigger",
            c.req.param("triggerId"),
            async (ctx) => await handleTriggerWebhook(ctx, c.req.raw, c.req.param("triggerId")),
        ),
);

// Gateway-first entry point — HMAC-signed by gateway, user JWT forwarded for auth
// Extension sign-in without cookies (the Firefox build) — PKCE code flow; see
// `auth/extension-grant.ts`. `authorize` needs the caller's bearer JWT; the
// other three authenticate with the code or the extension's session token.
app.post("/extension/auth/authorize", httpAction(authorizeExtensionHttpAction));
app.post("/extension/auth/exchange", httpAction(exchangeExtensionCodeHttpAction));
app.post("/extension/auth/token", httpAction(extensionAccessTokenHttpAction));
app.post("/extension/auth/revoke", httpAction(revokeExtensionSessionHttpAction));

app.post("/chat/start", httpAction(onCallerShard(chatStartHttpAction)));

// Chunk polling endpoint for LLM Gateway edge streaming (HMAC-signed)
app.post("/chat/chunks", httpAction(getChunksHttpAction));

// LLM Gateway usage report webhook (HMAC-signed by gateway)
app.post("/gateway/usage-report", httpAction(gatewayUsageReportHttpAction));

// Operator bootstrap for invite-only sign-up; bearer `LUNORA_ADMIN_TOKEN`.
app.post("/admin/seed-invitations", httpAction(seedInvitationsHttpAction));

// The e2e suite's invitations. 404 anywhere but a local development stack
// holding `E2E_SEED_TOKEN` — see `auth/e2e-seed-http.ts`.
app.post(E2E_INVITATIONS_PATH, httpAction(e2eSeedInvitationHttpAction));

// File uploads (TUS), for the signed-in browser — see `lib/upload-route.ts`.
// The finalize procedures take it from there by upload id. `GET` is listed for
// the TUS resume `HEAD`, which hono dispatches to `GET` routes (the raw request
// keeps its method); a real `GET` is refused there, the route being write-only.
const UPLOAD_METHODS = ["POST", "PATCH", "GET", "DELETE"];

app.on(UPLOAD_METHODS, [UPLOAD_PATH, `${UPLOAD_PATH}/:uploadId`], async (c) => await handleUploadRequest(c.var.lunora, c.req.raw, c.env["FILES"]));

// The same route for public API clients, API-key authenticated like the rest of
// `/api/v1` and gated on `knowledge:write` — the only v1 resource that uploads.
// Registered before the v1 router so it is reached at all.
app.on(
    UPLOAD_METHODS,
    [`${PUBLIC_API_PREFIX}${UPLOAD_PATH}`, `${PUBLIC_API_PREFIX}${UPLOAD_PATH}/:uploadId`],
    async (c) => await handleUploadRequest(c.var.lunora, c.req.raw, c.env["FILES"], publicApiUploadGate),
);

// Public v1 API — API-key authenticated (see `public-api/identity.ts`), with its
// own error shape, per-key limits and OpenAPI document at /api/v1/openapi.json.
app.route(PUBLIC_API_PREFIX, createPublicApiRouter());

/**
 * `captchaRequired` mirrors the one condition in `auth.ts` that decides whether
 * better-auth loads its captcha plugin.
 *
 * It is reported because the failure it causes is otherwise invisible: the
 * plugin turns on from `TURNSTILE_SECRET_KEY` alone, while the form only renders
 * a widget when the APP was built with `VITE_TURNSTILE_SITE_KEY`. Set one
 * without the other and every credential endpoint answers `MISSING_RESPONSE`
 * with no widget able to satisfy it — sign-up, sign-in and forgot-password all
 * dead, no error in the console, and a submit button that appears to do nothing.
 *
 * Two independent variables, no coupling check, silent in both directions. This
 * at least makes the server's half answerable: `curl /api/health`.
 */
app.get("/api/health", async (c) =>
    c.json({
        captchaRequired: Boolean(TURNSTILE_SECRET_KEY && TURNSTILE_SITE_KEY),
        // Set means the secret is present but the site key is not, so captcha is
        // OFF despite being half-configured. Bot protection is absent here.
        ...(TURNSTILE_SECRET_KEY && !TURNSTILE_SITE_KEY && { captchaMisconfigured: true }),
        environment: ENVIRONMENT || "unknown",
        status: "ok",
        timestamp: new Date().toISOString(),
    }),
);

/**
 * Worker-signed download URLs — `<PUBLIC_ORIGIN>/<key>?exp&method&bucket&sig`,
 * minted by `ctx.storage.getSignedUrl`. Keys contain slashes
 * (`agent-files/<hash>`), so this is a catch-all, and therefore registered
 * LAST: every real route above wins. An unsigned request falls through to the
 * 404 below. See `lib/signed-storage.ts`.
 */
const signedStorageOptions = () => {
    return {
        ...(PUBLIC_ORIGIN && { expectedOrigin: PUBLIC_ORIGIN }),
        secret: process.env.STORAGE_SIGNING_SECRET ?? "",
    };
};

app.on(["GET", "HEAD"], "/*", async (c) => (await handleSignedGet(c.var.lunora, c.req.raw, signedStorageOptions())) ?? c.notFound());

app.notFound((c) =>
    c.json(
        {
            error: "Endpoint not found",
            method: c.req.method,
            path: c.req.path,
        },
        404,
    ),
);

app.onError((error, c) => {
    httpLogger.error("HTTP Error:", error);

    return c.json(
        {
            error: "Internal server error",
        },
        500,
    );
});

export const httpApp = app;

export default app;
