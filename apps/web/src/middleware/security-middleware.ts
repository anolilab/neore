import { createMiddleware } from "@tanstack/react-start";

import { createPreviewShellResponse, isArtifactPreviewRequest } from "@/features/canvas/lib/preview-shell";
import env from "@/lib/env";

import { applyDefaultCacheControl } from "./cache-headers";

/**
 * Generates a cryptographically secure nonce for CSP.
 */
const generateNonce = (): string => {
    const array = new Uint8Array(16);

    crypto.getRandomValues(array);

    return btoa(String.fromCodePoint(...array));
};

/**
 * `connect-src` allowance for local models — loopback ONLY, and deliberately
 * unconditional.
 *
 * The CSP is sent by the server with every page, before it knows whether this
 * user configured a local endpoint (that lives in their preferences, behind
 * auth), so "only when configured" cannot be expressed per user. What keeps it
 * narrow instead:
 *
 * - **Loopback only.** `localhost` and `127.0.0.1` — the exact hosts
 *   `validateLocalEndpointUrl` (`@neore/ai/models`) accepts. No LAN ranges, no
 *   `*.local`: those would let a script on this page reach the user's router or
 *   NAS. `http:` also matches `https:` on the same hosts (CSP scheme upgrade).
 * - **User-initiated.** Nothing calls these hosts unless the user saved a
 *   local endpoint and then sent a message, tested it, or opened the model
 *   manager.
 * - **No new capability for an attacker.** `connect-src` limits where OUR page
 *   may fetch; `script-src` (nonce) is what stops injected code. A script that
 *   already ran here has the user's session, which is worth far more than
 *   their loopback — and the local server's own CORS setting (OLLAMA_ORIGINS,
 *   LM Studio's toggle) still decides whether it answers this origin at all.
 *   Chrome additionally gates public → loopback requests behind its Local
 *   Network Access permission prompt.
 * - **Not inherited by generated content.** Slide decks and canvas previews
 *   run model-written HTML in frames that inherit this policy, but each sets
 *   its own `connect-src 'none'`, and the stricter policy wins.
 *
 * `upgrade-insecure-requests` does not rewrite these in Chromium or Firefox,
 * which exempt loopback; Safari does, which is why the setup guide says local
 * models need Chrome, Edge or Firefox.
 */
export const LOCAL_MODEL_CONNECT_SOURCES = ["http://localhost:*", "http://127.0.0.1:*"] as const;

/** PostHog serves lazy-loaded extensions (recorder, surveys) from a sibling `-assets` host. */
const POSTHOG_REGION_HOST_RE = /^(eu|us)\.i\./u;

/**
 * Builds CSP directives based on the environment and nonce.
 *
 * Every host below is one the browser really talks to — a missing one breaks a
 * feature SILENTLY (a console CSP report, nothing in the UI), so when adding a
 * third-party call, add its host here in the same change.
 *
 * Dev runs the SAME nonce policy as production, plus `'unsafe-eval'` and the
 * localhost HMR sockets. That is deliberate: Vite's dev client, the React
 * Refresh preamble and TanStack Start's dev entry all load as external
 * `'self'` modules, and every inline script Start/Router/React emit carries
 * the nonce (via `ssr.nonce` in `router.tsx`). A relaxed dev policy would hide
 * exactly the breakage it is meant to catch before production.
 */
export const buildCSPDirectives = (nonce: string, isDevelopment: boolean = import.meta.env.DEV): string => {
    // Base domains for various services
    // One Lunora worker serves both `/_lunora/rpc` and `/api/auth/*`, so one origin.
    const lunoraDomain = new URL(env.VITE_LUNORA_URL).hostname;
    const posthogDomain = env.VITE_POSTHOG_HOST ? new URL(env.VITE_POSTHOG_HOST).hostname : "eu.i.posthog.com";
    const posthogAssetsDomain = posthogDomain.replace(POSTHOG_REGION_HOST_RE, "$1-assets.i.");
    const gatewayDomain = new URL(env.VITE_LLM_GATEWAY_URL).hostname;
    const consentOrigin = env.VITE_C15T_BACKEND_URL ? new URL(env.VITE_C15T_BACKEND_URL).origin : undefined;

    const directives: Record<string, string[]> = {
        // Base URI
        "base-uri": ["'self'"],

        // Connections (fetch, WebSocket, etc.)
        "connect-src": [
            "'self'",
            // Lunora backend
            `https://${lunoraDomain}`,
            `wss://${lunoraDomain}`,
            // PostHog (API + lazy-loaded extensions)
            `https://${posthogDomain}`,
            `https://${posthogAssetsDomain}`,
            // Analytics
            "https://cloudflareinsights.com",
            // ElevenLabs realtime dictation (composer voice input, token from /api/scribe-token)
            "wss://api.elevenlabs.io",
            // LLM Gateway — chat streaming, media, prompt optimizer, model list
            `https://${gatewayDomain}`,
            // Stored files — uploads and downloads alike — go through Worker-signed
            // URLs on the Lunora origin above (`backend/lunora/lib/signed-storage.ts`).
            // There is no public bucket and no direct-to-R2 URL to allow.
            // Rive persona animations: `.riv` files, and the Rive runtime's WASM from its CDN
            "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com",
            "https://cdn.jsdelivr.net",
            "https://unpkg.com",
            // c15t consent backend (only in `c15t` mode)
            ...(consentOrigin ? [consentOrigin] : []),
            // Local models (`features/local-models`): the browser calls the user's
            // own Ollama / LM Studio directly, because our servers cannot reach it.
            // LOCAL_MODEL_CONNECT_SOURCES says why this is safe to send to everyone.
            ...LOCAL_MODEL_CONNECT_SOURCES,
            // Dev server (HMR socket; http://localhost:* is already above)
            ...(isDevelopment ? ["ws://localhost:*"] : []),
        ],

        // Default fallback
        "default-src": ["'self'"],

        // Fonts — Google Fonts only for slide decks, whose srcdoc frames inherit this policy
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],

        // Form submissions
        "form-action": ["'self'"],

        // Frame ancestors (who can embed this site)
        "frame-ancestors": ["'self'"],

        // Frames
        "frame-src": [
            // Includes the canvas artifact preview shell (`/artifact-preview`)
            "'self'",
            // OAuth providers
            "https://accounts.google.com",
            // Turnstile captcha
            "https://challenges.cloudflare.com",
            // MCP Apps sandbox proxy — outer iframe that isolates interactive MCP App UIs
            // Must be on a different origin from the host app (security requirement)
            "https://proxy.mcpui.dev",
        ],

        // Images — any https host. Chat renders images from anywhere: model
        // markdown, web-search favicons/thumbnails, generated media on the
        // (runtime-configured) R2 public domain, marketing assets on ImageKit.
        // Images cannot execute, and script-src is what stops injection.
        "img-src": ["'self'", "data:", "blob:", "https:"],

        // Manifest
        "manifest-src": ["'self'"],

        // Media (audio, video) — same reasoning as img-src: generated video/music
        // and TTS audio come from runtime-configured hosts or blob:/data: URLs.
        "media-src": ["'self'", "data:", "blob:", "https:"],

        // Object/embed/applet
        "object-src": ["'none'"],

        // Scripts - nonce for inline scripts (see `ssr.nonce` in router.tsx)
        "script-src": [
            "'self'",
            `'nonce-${nonce}'`,
            // WebAssembly compilation: Photon image editor, Rive runtime
            "'wasm-unsafe-eval'",
            // Allow eval in development for HMR
            ...(isDevelopment ? ["'unsafe-eval'"] : []),
            // PostHog (lazy-loaded extensions)
            `https://${posthogDomain}`,
            `https://${posthogAssetsDomain}`,
            "https://static.cloudflareinsights.com",
            // Turnstile captcha loader
            "https://challenges.cloudflare.com",
        ],

        // Styles — deliberately NO nonce. A nonce makes browsers IGNORE
        // 'unsafe-inline', which would block every SSR'd `style="…"` attribute
        // and the <style> tags CodeMirror, Univer, sonner and friends inject at
        // runtime. Inline style is not a script-execution vector.
        "style-src": [
            "'self'",
            "'unsafe-inline'",
            // Slide decks (srcdoc frames inherit this policy)
            "https://fonts.googleapis.com",
        ],

        // Web Workers
        "worker-src": ["'self'", "blob:"],

        // Upgrade insecure requests in production
        ...(!isDevelopment && { "upgrade-insecure-requests": [] }),
    };

    // Build the CSP string
    return Object.entries(directives)
        .map(([key, values]) => (values.length > 0 ? `${key} ${values.join(" ")}` : key))
        .join("; ");
};

/**
 * Copies `response` with the app's security headers applied. A `fetch`-made
 * Response (better-auth's) has IMMUTABLE headers, so this always rebuilds.
 */
export const withSecurityHeaders = (response: Response, csp: string, isDevelopment: boolean = import.meta.env.DEV): Response => {
    const headers = new Headers(response.headers);

    // Content Security Policy
    headers.set("Content-Security-Policy", csp);

    // Prevent MIME type sniffing
    headers.set("X-Content-Type-Options", "nosniff");

    // Prevent clickjacking
    headers.set("X-Frame-Options", "SAMEORIGIN");

    // Enable XSS filter (legacy browsers)
    headers.set("X-XSS-Protection", "1; mode=block");

    // Control referrer information
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    // Enforce HTTPS (only in production — localhost is HTTP)
    if (!isDevelopment) {
        headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    // Permissions Policy (formerly Feature-Policy)
    headers.set(
        "Permissions-Policy",
        [
            "accelerometer=()",
            "camera=()",
            "geolocation=()",
            "gyroscope=()",
            "magnetometer=()",
            "microphone=(self)", // Allow microphone for voice input
            "payment=()",
            "usb=()",
        ].join(", "),
    );

    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
};

/**
 * Security middleware that adds CSP and other security headers to responses.
 * Generates a unique nonce per request for inline scripts/styles.
 */
const securityMiddleware = createMiddleware({ type: "request" }).server(async ({ handlerType, next, request }) => {
    // The canvas artifact preview shell carries its OWN policy (inline scripts,
    // CDN allowlist, `sandbox allow-scripts`) and must never get the app's nonce
    // CSP, so it is answered here, before any other middleware or header runs.
    // See `features/canvas/lib/preview-shell.ts`.
    if (isArtifactPreviewRequest(request)) {
        return createPreviewShellResponse(request);
    }

    // Generate a unique nonce for this request
    const nonce = generateNonce();

    // Continue to next middleware/route with nonce in context
    const result = await next({
        context: {
            security: {
                nonce,
            },
        },
    });

    // `next()` resolves to the middleware CONTEXT (`{ request, pathname,
    // context, response }`), never a bare Response — an earlier
    // `result instanceof Response` check here was never true, so for a long
    // time no security header was sent at all. Mirrors `lingui-middleware.ts`.
    const response = withSecurityHeaders(result.response, buildCSPDirectives(nonce));

    // Folded in here because this already rebuilds the response; see cache-headers.ts.
    applyDefaultCacheControl(response.headers, handlerType);

    return {
        ...result,
        response,
    };
});

export default securityMiddleware;
