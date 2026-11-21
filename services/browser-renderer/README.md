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
| `POST /login`  | Sign in with a saved login in one call (`src/login.ts`); never returns the password  |
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
pnpm lint:oxfmt   # from the repository root: formatting is checked repo-wide
pnpm --filter browser-renderer build      # wrangler deploy --dry-run
pnpm --filter browser-renderer test       # unit tests (scrubbing)
pnpm --filter browser-renderer test:browser   # the saved-login fill against a local Chromium
```

From before `/login` loads the login page until the password is cleared, the tab starts no worker, shared worker or new
window, has no WebRTC, WebTransport, `WebSocketStream`, `fetchLater`, keepalive fetch or beacon, and cannot reach a
service worker (`src/channels.ts`). Other tabs of the session are closed when it starts. A login page that needs any of
these fails rather than signs in; a sign-in that stops before anything is typed leaves the tab on `about:blank`, so the
session goes on from a page loaded without the lock. Speculation rules, whose
prefetches and prerenders the browser sends past request interception, are taken out too: a `Speculation-Rules` header
is dropped from the tab's documents, and each `<script type="speculationrules">` is removed as it is added, in the
document and in every shadow root a script makes or reaches, including one whose type a script changes after it is in.
So that the page cannot parse rules where no script reaches (a declarative shadow root), `document.open` and
`document.write` throw once the page is parsed and a top-level `blob:` page is stopped. A rule set that stays (one in a
declarative shadow root of the page as served) means nothing is typed, and a speculative load the browser starts once
the password is typed counts as an attempt; that is reported, not stopped, since the browser has already sent it.

The page never holds the password. Its field gets a random stand-in (64 letters and digits, or the password's length
when longer, within the field's `maxlength`), and request interception puts the password in its place only in the
main frame's POST to the form's action address, only as the password field's value, and only when the stand-in is
nowhere else in the body. That action and field are the ones of the page as the site sent it, loaded first with
scripts off: a form a script points elsewhere or builds itself is not typed into, since it could send the password to an
address of the site that keeps and shows it. A POST elsewhere, or one where the page moved or copied the stand-in, is
not sent. Neither is a redirect of the answer whose address carries the password in its query or fragment, in any
spelling (encoded twice included): that counts as an attempt. A password short enough to be part of an ordinary
query (`1234` in `?tab=12345`) can fail a sign-in that way after the site took it; the result says it was sent. Scripts are off for the document that answers the POST and for the cleanup's reload, which is checked before
the lock lifts and only then loaded with its scripts. So no page
script can read the password, by the field's value or any other way (other realms, events, `FormData`, selection), and a
`<link rel="preconnect">` or a `javascript:` page can only carry the stand-in. A site that signs in from a script (a
fetch, XHR or socket message with what it read from the field) cannot be filled: that is reported as `scriptSignIn`,
and nothing is sent. So is a form sent as `text/plain`, or in a charset other than UTF-8 when the password is not ASCII.

Not covered: the stand-in's length tells the page the length of a password longer than 64 characters. A site whose
server shows the password in another spelling than those `isClean` knows, or only to a later request, has its scripts
read it. A `/login` whose browser is not ready in time, or whose page cannot be set up, closes only a browser it launched: a
session it reconnected to is left to its keepAlive, as `/action` leaves it. `/login` holds its session alone against other calls of the same isolate (a `409` for an `/action`
on it); a call from another isolate is not excluded.

`test:browser` drives `src/login.ts` through local test sites on 127.0.0.1 and 127.0.0.2 (two origins), with
cross-site frames in their own process, and needs
Chromium (`pnpm --filter browser-renderer exec playwright install chromium`). CI's unit-test job installs no browser,
so it runs only `test`. Deploys belong to CI (Alchemy); do not run the
package's `deploy` script or `pnpm deploy`.
