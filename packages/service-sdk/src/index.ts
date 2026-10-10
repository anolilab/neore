/**
 * `@neore/service-sdk` — Typed SDK clients for all internal services.
 *
 * Each service has its own sub-export (e.g., `@neore/service-sdk/llm-gateway`).
 * Every client takes the service binding's `fetch`; there is no URL or signing
 * secret — the services are reached over Cloudflare service bindings.
 */
export {
    createBrowserRendererClient,
    createDocumentParserClient,
    createLlmGatewayClient,
    createNsfwCheckerClient,
    createServiceClient,
    type ServiceClientConfig,
    type ServiceFetch,
} from "./client-factory.js";
