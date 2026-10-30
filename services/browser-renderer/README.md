# Browser renderer

A Cloudflare Worker (Hono) that drives a real Chromium on Cloudflare Browser
Rendering through `@cloudflare/playwright`. It backs the chat's `browserTool`
([`docs/browser.mdx`](../../docs/browser.mdx)). `docs/services/browser-renderer.mdx` still
describes HMAC auth and `*_URL` wiring from before the service bindings; the code
here has neither.

## Who calls it

Only the Lunora backend, over the `SERVICE_BROWSER_RENDERER` service binding.
The Worker is **private**: `workers_dev: false`, no route, and Alchemy deploys
it with `workersDev: false`. It has no auth of its own, because the binding is
the only way in. The backend side is `chat/tools/browser-node.ts`, which reaches
it through the typed client in `@neore/service-sdk/browser-renderer` and
`serviceFetch(ctx, "browserRenderer")`, and offers the tool only when
`isServiceBound` says the binding exists.

The SSRF guard for the URL the model supplies sits in two places: `validateDomain`
in the backend's `chat/tools/utilities.ts`, and `validateUrl` here, which blocks
metadata hosts, loopback, private, link-local, CGNAT and reserved IPv4 and IPv6
ranges. In this Worker every request the page makes (redirects, subresources,
popups) passes the same check, and a redirect to a blocked URL closes the browser.

## API

| Route          | Purpose                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `POST /action` | One browser action: `navigate`, `screenshot`, `click`, `type`, `extract` or `scroll` |
| `GET /health`  | `{ "service": "browser-renderer", "status": "ok" }`                                  |

The body is validated by `actionSchema` in `src/index.ts` (`action`, plus
`url`, `selector`, `text`, `direction`, `fullPage` and `sessionId` as the action
needs). A new launch is started with `keepAlive` of 60 s, and the response
carries a `sessionId`; passing it on the next call reconnects, so
`navigate`, `click` and `extract` can be separate tool calls. An expired
session falls back to a fresh launch. The Worker never closes a kept-alive
browser itself. Most page operations time out at 30 s and navigation at 60 s; `extract`
without a selector and `scroll` use `page.evaluate`, which takes no timeout.

The Browser Rendering binding is `BROWSER`; there are no secrets. There is no
Browserbase or `playwright-core` path any more, and `BROWSERBASE_API_KEY` does
nothing.

## Run it

In the full stack you run nothing: `lunora dev` (started by `pnpm dev` through
the backend's dev target) runs this Worker inside the backend's own
`wrangler dev` session, with no port of its own.

Alone, for spec extraction or poking at it directly:

```bash
pnpm dev:browser-renderer      # from the root; or: pnpm --filter browser-renderer dev
```

That serves `http://localhost:8789` with the inspector on 9232. Check `ss -lntp`
first; 8788 belongs to the backend, and each service's inspector port is pinned.

## Checks

```bash
pnpm --filter browser-renderer lint:types
pnpm --filter browser-renderer lint:eslint
pnpm --filter browser-renderer lint:prettier
pnpm --filter browser-renderer build      # wrangler deploy --dry-run
```

The package has no unit tests. Deploys belong to CI (Alchemy); do not run the
package's `deploy` script or `pnpm deploy`.
