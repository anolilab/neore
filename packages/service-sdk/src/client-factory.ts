/**
 * Generic service client factory.
 *
 * The services are reached over Cloudflare service bindings, not over the
 * internet: the caller passes the binding's `fetch` (in the backend,
 * `ctx.services.&lt;key>.fetch`, wrapped by `lib/services.ts#serviceFetch`). There
 * is no base URL to configure and nothing to sign — a binding delivers the
 * request to its Worker whatever the host says, so `baseUrl` is only a
 * well-formed placeholder.
 */
// The fetch client is no longer a package: `@hey-api/client-fetch` was deprecated
// ("bundled directly inside @hey-api/openapi-ts" from v0.73), so the generator now
// emits it into each service's output. The four copies are byte-identical, so this
// factory uses the llm-gateway one as the canonical source rather than adding a
// hand-maintained fifth.
import type { Client, Config } from "./generated/llm-gateway/client/index.js";
import { createClient } from "./generated/llm-gateway/client/index.js";

/** A `fetch` bound to one service — a service binding's `fetch`. */
type ServiceFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

interface ServiceClientConfig {
    /** Placeholder origin for the request URLs; the binding ignores the host. */
    baseUrl?: string;
    /** The service binding's `fetch`. Every request of this client goes through it. */
    fetch: ServiceFetch;
    fetchOptions?: Config;
}

const createBoundClient =
    (defaultBaseUrl: string) =>
    (config: ServiceClientConfig): Client =>
        createClient({
            baseUrl: config.baseUrl ?? defaultBaseUrl,
            // The generated client calls `fetch(request)`; a binding's fetch takes the same.
            fetch: config.fetch as typeof globalThis.fetch,
            ...config.fetchOptions,
        });

export const createServiceClient = createBoundClient("https://service.internal");
export const createBrowserRendererClient = createBoundClient("https://browser-renderer.internal");
export const createDocumentParserClient = createBoundClient("https://document-parser.internal");
export const createLlmGatewayClient = createBoundClient("https://llm-gateway.internal");
export const createNsfwCheckerClient = createBoundClient("https://nsfw-checker.internal");
export type { ServiceClientConfig, ServiceFetch };
