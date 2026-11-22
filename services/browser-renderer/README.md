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

The Browser Rendering binding is `BROWSER`, and `SESSION_LOCK` is the Durable Object that holds each session (declared with its migration in `wrangler.jsonc`, and in `alchemy.run.ts`, which creates it SQLite-backed); there are no secrets. There is no
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
moved there, the session is closed instead. While the guard holds, a request body over 1 MiB is not looked into: the
login form's own is not sent, and another to the login's site is aborted. The form is sent only with the `enctype` and
`accept-charset` of the form the site served. The tab's scripts are turned back on when the guard lets go; when that is not
confirmed within a second, the session is closed. Speculation rules, whose
prefetches and prerenders the browser sends past request interception, are taken out too: a `Speculation-Rules` header
is dropped from the tab's documents, and each `<script type="speculationrules">` is removed as it is added, in the
document and in every shadow root a script makes or reaches, including one whose type a script changes after it is in.
So that the page cannot parse rules where no script reaches (a declarative shadow root), `document.open` and
`document.write` throw once the page is parsed and a top-level `blob:` page is stopped. A rule set that stays (one in a
declarative shadow root of the page as served) means nothing is typed, and a speculative load the browser starts once
the password is typed counts as an attempt; that is reported, not stopped, since the browser has already sent it.

The page never holds the password. Its field gets a random stand-in (64 letters and digits within the field's `minlength` and `maxlength`, and built to
the field's `pattern` as below; its length never depends on the password's, and a password longer than `maxlength` is
sent whole, since refusing it would let the page learn the length by setting `maxlength`), and request interception puts the password in its place only in the
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
body, a service worker's answer, not `text/html`, over 2 MB in UTF-8, a tag of more than 256 attributes or more parsing than about 0.2 s of it (parse5 is not interrupted, and its work grows with the square of the nesting), or bytes the browser does not hand back as text, as it does
not for Shift_JIS or an undeclared charset with non-ASCII bytes), when a redirect of the load passed through another
site, or when the site's first password field is in no form parse5 sees (a form inside a table, which the browser's
parser ties to its fields without holding them). A page with password forms to more than one place (a sign-up form
beside the login form), one of the page's password forms whose submit buttons go to different places (a search form without a password field may have buttons that disagree), a login form only in a declarative shadow root,
and a `url` that differs from the tab's address only by its fragment are refused too, as is a saved username that holds the password (in any case), since the username is typed before the guard holds. The capture has been run
against Playwright's Chromium only, not yet on Browser Rendering; there, a body it does not hand back refuses every
sign-in rather than allow one. Not covered: a script can still change the other fields of the body (a hidden field, or the username), as the site's own scripts do, or send a form of its own with the stand-in in the password field's name to the same action; a site where such a field alone picks what the password signs into would take the password for the
script's choice. The same goes for a 307 or 308 redirect of the POST to another address of the same site, which carries
the body there, and for cookies a script of the site set earlier, which shape the page the site sends. The check proves
the site sent the form, not that it is a sign-in: `url` (any page of `origin`) decides that, so a caller pointing it at
a page that asks for the password to change an email or delete the account would have it typed there.
The form's target is this window: empty, `_self`, or `_parent` and `_top`, which name it, as the top window. A POST elsewhere, or one where the page moved or copied the stand-in, is
not sent. Neither is a redirect of the answer whose address carries the password in its query or fragment, in any
spelling (percent-encoded any number of times included), from the moment that POST is handed on with the password: that counts as an attempt. A POST that is refused leaves addresses unchecked for the password, which never left, so a script cannot learn from which address is stopped whether a guess is right. A password short enough to be part of an ordinary
query (`1234` in `?tab=12345`) can fail a sign-in that way after the site took it; the result says it was sent. Only the first such POST is sent; another the page starts meanwhile is not, and neither is one still waiting when the sign-in gives up. When the browser cannot turn scripts off for the answer, nothing is sent; a POST handed on counts as sent, since it may have reached the site, so it is never sent again. Scripts are off for the document that answers the POST, and it is never loaded again. So no page
script can read the password, by the field's value or any other way (other realms, events, `FormData`, selection), and a
`<link rel="preconnect">` or a `javascript:` page can only carry the stand-in. A site that signs in from a script (a
fetch, XHR or socket message with what it read from the field) cannot be filled: that is reported as `scriptSignIn`,
and nothing is sent. So is a form sent as `text/plain`, or in a charset other than UTF-8, whatever the password (a page that declares no
charset is read as windows-1252, so it is refused too): a refusal that hung on the password would tell the page about it.

The cleanup does the same steps whatever it finds, so nothing the page or its site can see hangs on the password: with
scripts still off it leaves the answer for `about:blank`, cuts the tab's history to that page and clears the browser's
HTTP cache, so no script goes back to the answer. Only then, where nothing of the site runs, it looks at the one place a script-free answer can leave the password for
later: the cookies a script could read that the site set in answer to the form's POST, along its redirects (storage,
IndexedDB and caches are written only by scripts, which ran only before the password was there). Never the whole cookie
jar: a page that planted guesses in it would learn from the outcome whether one is the password, while the site that set
those lines was sent the password. clean, the lock lifts and the session goes on
from a blank tab, loaded afresh without the lock; not, the tab and its browser are closed (`sessionClosed`). So the
answer's own markup holding the password, by echo or by chance (a short password), costs nothing: it is gone with the
answer. Not covered: whether the session goes on is the caller's to see, and so is anything that follows from it (its
next calls reach the site or do not, a service worker of the site that outlives the tab sees the browser go on or close,
and the site's server sees its connections end sooner when the browser closes); the steps' timing is not padded to one
length. A site whose server shows the password only to a later request has its scripts read it then. Every text a result carries (the address, the title, an error) that holds the password in any spelling is withheld whole, never marked where it matched: a mark would say which of the guesses a page put there is the password. Until the site has been sent the password, a result names nothing the page chose (no address, no other site's name, no browser error text, only the sign-in's own reasons), since whether such a text is withheld would say whether a guess the page put in it is right. Once it has, the result gives the answer's address and title only when the answer is a document of its own: a site that answers with none (a `204`) leaves the page's, so the result names `origin` and no title. A text is read through as many layers of percent-encoding as it has; one with more than 32 that are not escapes of `%` alone is taken to hold the password, so it is withheld. A lock that cannot be set up whole leaves the tab on `about:blank`, and one that does not settle in time closes the session. A cross-site frame runs only once each of its lock commands (the lock script, the hold on its own frames) is confirmed; one that fails, or is not confirmed within 5 s, leaves the frame paused, and the sign-in fails with the tab and its browser closed, since letting go of the lock would let the frame run. An answer to the sign-in with an HTTP error status is reported as sent, not signed in. A `/login` whose browser is not ready in time, or whose page cannot be set up, closes only a browser it launched: a
session it reconnected to is left to its keepAlive, as `/action` leaves it. A setup still under way at the deadline keeps the session held past the answer until it ends, as a close does, and one that never ends lets the hold lapse, which retires the session. `/login` holds its session alone from before it connects until its cleanup ends, against every call of every isolate: Browser Rendering lets several connections share one session, so the hold is a Durable Object per session id (`SessionLock`, `src/session-lock.ts`, bound as `SESSION_LOCK`). An `/action` on a session holds it beside other actions for its whole run and gets a `409` while a sign-in holds it (the backend tells the agent to try again in a moment); an answer that ran nothing (that `409`, a `410`, a `503` from the lock) carries `x-browser-action: not-run`, and the backend gives back the action's rate-limit charge; a `/login` gets a `409` while any other call holds it. A session either launched is held too, before its page is set up. Holds have a 30 s lease, renewed every 5 s while the call runs (a `/login` whose release goes unanswered sends it again past the answer, under `waitUntil`, while its last confirmed lease runs, so a lost reply does not retire a session the cleanup left clean), so an isolate that dies during an `/action` frees its session within a lease. One that dies during a `/login` (or whose close never ends) lets its exclusive hold lapse instead of releasing it, and a lapsed exclusive hold retires the session for good: every later call on that id is refused with a `410` and `code: "SESSION_RETIRED"`, since Browser Rendering keeps the browser, and the page the site answered with, open past the lease; the caller starts a new session (the backend drops the id, and runs a navigate at once on a new browser). The lapse and the retired flag are one write of the lock's state. A shared hold that lapses instead of being released keeps a `/login` out for 30 s more, and an `/action` whose hold goes unrenewed until 10 s before it could lapse closes its browser connection there and then, so it drives the page no further. Each take has its own token, and a release is kept by the lock for the longest lease (10 min): a take whose answer timed out is released at once, and should that take still reach the lock after its release, it holds nothing, so it cannot leave a hold no one releases, which would retire the session. It fails closed: when the lock does not answer within 3 s, the call is refused with a `503` before it connects (so an outage of the lock stops every call on an existing session, and a new launch costs one call to the lock); an `/action` whose hold may have lapsed during its run (the lock says it is gone, or its lease ran into the margin) has its result withheld (`503`, saying the action may have run and keeping the `sessionId` of a browser it did not close), while one whose release the lock is only slow to answer keeps its result, the lease then ending on its own; and a `/login` whose hold goes unrenewed until 10 s before it could lapse closes its browser, answering `sessionCloseUnconfirmed`. A session it must close stays held until the close ends, while the answer goes out by the deadline, leaving the hold's last 2 s to it: `sessionClosed` once the browser confirmed the close, else `sessionCloseUnconfirmed` (the session may still be open). Such a hold is kept for the 60 s keepAlive and one lease past the answer, since a browser no call reaches is reclaimed by then, and a close that ends meanwhile lets go of it. Before typing, the stand-in is built from the password field's `pattern` and `minlength`, never tested against the pattern: the page's regular expression is not run in the Worker, where one that backtracks would stall it (`src/field-pattern.ts`). A pattern the browser does not compile is ignored, as the browser ignores it; one that is a plain sequence of literal letters and digits, `.`, `\d`, `\w`, `\S` and classes of ranges, each with a quantifier (`A[A-Za-z0-9]{63}`, `[0-9]*` for a PIN field), gets a stand-in made step by step; any other (a group, an alternation, a lookahead, a negated class, one that needs a symbol, or one over 512 characters) has nothing typed, the same way every time, and so has a field whose pattern or `minlength` asks for a stand-in under 4 or over 1024 characters (the guard looks for the stand-in in every request), and one whose rules leave fewer than 2^40 stand-ins (a literal, `\d{4}`, or `maxlength` 6). So a short PIN field is always refused, by design: with so few stand-ins a page could set its rules so that a guess is one of them: whether a field is refused never depends on the password, and a stand-in that comes out as the password is drawn again, so a page that sets the rules to a guess learns nothing of it; a form its own rules would hold back (a required field left empty) is reported at once, unsent. The DevTools session that reads the served page must let go of it within the hold, or nothing is typed; each read of the page before the password is typed has its own time limit, and a guard for the send that is not set up in time closes the session.

`test:browser` drives `src/login.ts` through local test sites on 127.0.0.1 and 127.0.0.2 (two origins), with
cross-site frames in their own process, and needs
Chromium (`pnpm --filter browser-renderer exec playwright install chromium`). CI's unit-test job installs no browser,
so it runs only `test`. Deploys belong to CI (Alchemy); do not run the
package's `deploy` script or `pnpm deploy`.
