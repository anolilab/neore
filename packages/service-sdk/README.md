# @neore/service-sdk

Typed clients for the Workers under `services/`, generated from their OpenAPI
specs with `@hey-api/openapi-ts`. Private, built with packem to `dist/`.

The services are reached over Cloudflare service bindings, so every client
takes the binding's `fetch`. There is no base URL to configure and nothing to
sign: a binding delivers the request to its Worker whatever the host says, and
`baseUrl` is only a well-formed placeholder.

Used by `backend/lunora` (document extraction, the browser tool, knowledge
ingest, and the gateway and NSFW-checker clients).

## Exports

| Subpath                               | Client                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@neore/service-sdk`                  | `createServiceClient`, `createLlmGatewayClient`, `createDocumentParserClient`, `createNsfwCheckerClient`, `createBrowserRendererClient`, plus `ServiceFetch` and `ServiceClientConfig` |
| `@neore/service-sdk/llm-gateway`      | The gateway's generated operations and `createLlmGatewayClient`                                                                                                                        |
| `@neore/service-sdk/document-parser`  | e.g. `extractDocument`, `createDocumentParserClient`                                                                                                                                   |
| `@neore/service-sdk/nsfw-checker`     | The NSFW checker's operations and `createNsfwCheckerClient`                                                                                                                            |
| `@neore/service-sdk/browser-renderer` | e.g. `browserAction`, `createBrowserRendererClient`                                                                                                                                    |

```ts
// backend/lunora/agent/extraction.ts (in an action)
import { createDocumentParserClient, extractDocument } from "@neore/service-sdk/document-parser";

import { serviceFetch } from "../lib/services"; // backend/lunora/lib/services.ts

const client = createDocumentParserClient({ fetch: serviceFetch(ctx, "documentParser") });
const { data, error } = await extractDocument({ body, client, headers: { "content-type": mediaType } });
```

In the backend, get the `fetch` from `lib/services.ts` (`serviceFetch`,
`gatewayFetch`), never by passing `ctx.services.x.fetch` detached: a `Fetcher`
method called off its binding throws `Illegal invocation`. `ctx.services`
exists on actions only. See root `CLAUDE.md`, "Services (service bindings)".

## Layout

- `openapi/*.json`: one spec per service (`llm-gateway`, `document-parser`,
  `nsfw-checker`, `browser-renderer`, `embeddings`).
- `src/generated/<service>/`: generator output, committed. Do not edit;
  prettier ignores it (`.prettierignore`). `embeddings` has a spec but no
  sub-export: nothing calls it.
- `src/client-factory.ts`: the hand-written client factory. It uses the
  llm-gateway copy of the generated fetch client for all services.
- `src/<service>.ts`: the public sub-export for each service.

## Regenerating

```bash
# 1. Refresh the specs of the services that serve one. Start llm-gateway (:8787)
#    and nsfw-checker (:8791) standalone first (`pnpm dev:llm-gateway`, `pnpm dev:nsfw-checker`).
pnpm --filter @neore/service-sdk run generate:extract

# 2. Generate the clients from openapi/*.json
pnpm --filter @neore/service-sdk run generate
```

`browser-renderer` and `embeddings` use plain Hono, and `document-parser` is a
Rust Worker, so their specs in `openapi/` are maintained by hand. The generate
script also renames the generated `Options` type to `SdkOptions`, so packem's
declaration bundle does not emit `Options` / `Options$1`.

## Development

```bash
pnpm --filter @neore/service-sdk run build        # packem build --development
pnpm --filter @neore/service-sdk run build:prod
pnpm --filter @neore/service-sdk run lint:types   # tsc --noEmit
pnpm --filter @neore/service-sdk run lint:eslint
```

There is no test script. Consumers read `dist/`, so build it first in a fresh
checkout (`pnpm build:packages`); without it a return type imported from here
degrades to `unknown` in backend codegen while codegen still exits 0.
