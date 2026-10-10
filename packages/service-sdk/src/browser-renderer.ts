/**
 * Browser Renderer SDK
 *
 * Re-exports the generated SDK client and provides a client factory for the
 * Browser Renderer service, reached over a Cloudflare service binding.
 * @example
 * ```ts
 * import { createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
 *
 * // In a Lunora action:
 * const client = createBrowserRendererClient({ fetch: (input, init) => ctx.services.browserRenderer.fetch(input, init) });
 * ```
 */
export { type ServiceClientConfig as BrowserRendererClientConfig, createBrowserRendererClient, type ServiceFetch } from "./client-factory.js";
export * from "./generated/browser-renderer/index.js";
