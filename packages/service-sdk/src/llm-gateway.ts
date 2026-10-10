/**
 * LLM Gateway SDK
 *
 * Re-exports the generated SDK client and provides a client factory for the
 * LLM Gateway service, reached over a Cloudflare service binding.
 *
 * The backend binds the gateway's `InternalApi` entrypoint — the only way into
 * its `/internal/*` routes.
 * @example
 * ```ts
 * import { createLlmGatewayClient } from "@neore/service-sdk/llm-gateway";
 *
 * // In a Lunora action:
 * const client = createLlmGatewayClient({ fetch: (input, init) => ctx.services.llmGateway.fetch(input, init) });
 * ```
 */
export { createLlmGatewayClient, type ServiceClientConfig as LlmGatewayClientConfig, type ServiceFetch } from "./client-factory.js";
export * from "./generated/llm-gateway/index.js";
