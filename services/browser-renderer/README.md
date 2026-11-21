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
session goes on from a page loaded without the lock; when the lock does not let go within a second, or the tab cannot be
moved there, the session is closed instead. Speculation rules, whose
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
nowhere else in the body. That form must be the one the site sent. The login page is loaded once, past the HTTP cache,
and the HTML the site sent for that load (the main-frame document's response body, read over the DevTools protocol as
the browser decoded it, and only while the tab still shows that load's document) is parsed in the Worker
(`src/served-form.ts`, with parse5), where no page script reaches. The live form's action (the submit button's
`formaction` included; an empty one is the page's own address), method, enctype, target and `accept-charset` must be
exactly those the site sent for its password fields, all of which must go to that one place, through submit buttons
that all agree, and the field typed into must have the name of one of them; the guard then sends only to that action
and field. A per-load value in the action (a `session_code` or `state`) is matched against its own load, so a script
that swaps it, a key or the path, points the button elsewhere, changes the encoding, builds the form, moves the tab to
another page, or hides the site's login form so that another of its forms is filled, has nothing typed. Faking what the
page reports gains nothing either: what goes out is held to the served action and field name. Nothing is typed, with a
result saying the browser cannot check where the form sends the password, when that HTML cannot be read whole (no
body, a service worker's answer, not `text/html`, over 2 MB, or bytes the browser does not hand back as text, as it does
not for Shift_JIS or an undeclared charset with non-ASCII bytes), when a redirect of the load passed through another
site, or when the site's first password field is in no form parse5 sees (a form inside a table, which the browser's
parser ties to its fields without holding them). A page with password forms to more than one place (a sign-up form
beside the login form), one of the page's password forms whose submit buttons go to different places (a search form without a password field may have buttons that disagree), a login form only in a declarative shadow root,
and a `url` that differs from the tab's address only by its fragment are refused too. The capture has been run
against Playwright's Chromium only, not yet on Browser Rendering; there, a body it does not hand back refuses every
sign-in rather than allow one. Not covered: a script can still change the other fields of the body (a hidden field, or the username), as the site's own scripts do, or send a form of its own with the stand-in in the password field's name to the same action; a site where such a field alone picks what the password signs into would take the password for the
script's choice. The same goes for a 307 or 308 redirect of the POST to another address of the same site, which carries
the body there, and for cookies a script of the site set earlier, which shape the page the site sends. The check proves
the site sent the form, not that it is a sign-in: `url` (any page of `origin`) decides that, so a caller pointing it at
a page that asks for the password to change an email or delete the account would have it typed there.
The form's target is this window: empty, `_self`, or `_parent` and `_top`, which name it, as the top window. A POST elsewhere, or one where the page moved or copied the stand-in, is
not sent. Neither is a redirect of the answer whose address carries the password in its query or fragment, in any
spelling (encoded twice included): that counts as an attempt. A password short enough to be part of an ordinary
query (`1234` in `?tab=12345`) can fail a sign-in that way after the site took it; the result says it was sent. Only the first such POST is sent; another the page starts meanwhile is not, and neither is one still waiting when the sign-in gives up. When the browser cannot turn scripts off for the answer, nothing is sent; a POST handed on counts as sent, since it may have reached the site, so it is never sent again. Scripts are off for the document that answers the POST and for the cleanup's reload, which is checked before
the lock lifts and only then loaded with its scripts. So no page
script can read the password, by the field's value or any other way (other realms, events, `FormData`, selection), and a
`<link rel="preconnect">` or a `javascript:` page can only carry the stand-in. A site that signs in from a script (a
fetch, XHR or socket message with what it read from the field) cannot be filled: that is reported as `scriptSignIn`,
and nothing is sent. So is a form sent as `text/plain`, or in a charset other than UTF-8 when the password is not ASCII.

Not covered: the stand-in's length tells the page the length of a password longer than 64 characters. A site whose
server shows the password in another spelling than those `isClean` knows, or only to a later request, has its scripts
read it. A lock that cannot be set up whole leaves the tab on `about:blank`, and one that does not settle in time closes the session. An answer to the sign-in with an HTTP error status is reported as sent, not signed in. A `/login` whose browser is not ready in time, or whose page cannot be set up, closes only a browser it launched: a
session it reconnected to is left to its keepAlive, as `/action` leaves it. `/login` holds its session alone against other calls of the same isolate (a `409` for an `/action`
on it); a call from another isolate is not excluded. A session it must close stays held until the close ends, while the answer goes out within the hold.

`test:browser` drives `src/login.ts` through local test sites on 127.0.0.1 and 127.0.0.2 (two origins), with
cross-site frames in their own process, and needs
Chromium (`pnpm --filter browser-renderer exec playwright install chromium`). CI's unit-test job installs no browser,
so it runs only `test`. Deploys belong to CI (Alchemy); do not run the
package's `deploy` script or `pnpm deploy`.
