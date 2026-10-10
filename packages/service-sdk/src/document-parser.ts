/**
 * Document Parser SDK
 *
 * Re-exports the generated SDK client and provides a client factory for the
 * Document Parser service, reached over a Cloudflare service binding.
 * @example
 * ```ts
 * import { createDocumentParserClient } from "@neore/service-sdk/document-parser";
 *
 * // In a Lunora action:
 * const client = createDocumentParserClient({ fetch: (input, init) => ctx.services.documentParser.fetch(input, init) });
 * ```
 */
export { createDocumentParserClient, type ServiceClientConfig as DocumentParserClientConfig, type ServiceFetch } from "./client-factory.js";
export * from "./generated/document-parser/index.js";
