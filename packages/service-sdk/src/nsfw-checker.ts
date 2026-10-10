/**
 * NSFW Checker SDK
 *
 * Re-exports the generated SDK client and provides a client factory for the
 * NSFW Checker service, reached over a Cloudflare service binding.
 * @example
 * ```ts
 * import { createNsfwCheckerClient } from "@neore/service-sdk/nsfw-checker";
 *
 * // In a Lunora action:
 * const client = createNsfwCheckerClient({ fetch: (input, init) => ctx.services.nsfwChecker.fetch(input, init) });
 * ```
 */
export { createNsfwCheckerClient, type ServiceClientConfig as NsfwCheckerClientConfig, type ServiceFetch } from "./client-factory.js";
export * from "./generated/nsfw-checker/index.js";
