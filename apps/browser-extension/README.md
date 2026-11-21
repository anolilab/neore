# Anole Chat — browser extension

MV3 extension for Chrome and Firefox. The side panel (a sidebar in Firefox) is
the whole product: sign in, thread list, chat with streaming replies, model
picker, settings.

## What it does

| Entry point                                                 | Action                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Toolbar icon / `Alt+Shift+K`                                | Open the side panel (Firefox: toggle the sidebar)                                    |
| Right-click page → **Chat with this page** / `Alt+Shift+P`  | New chat with the page's readable text attached                                      |
| Right-click page → **Summarize this page**                  | New chat, sends a summary request at once                                            |
| Right-click selection → **Explain / Summarize / Translate** | New chat, sends that quick prompt with the selection attached                        |
| **Attach this page** in the composer                        | Attach the active tab — works only on a tab the extension was invoked on (see below) |

## Security model

- **Permissions:** `activeTab`, `scripting`, `contextMenus`, `identity`,
  `storage`, plus `sidePanel` (Chrome). Host permissions cover only the backend
  and the gateway — not the app origin, whose cookie the extension never uses —
  and no `<all_urls>`, no declared content scripts.
- **Page reading is on demand.** `src/page-context/extract.ts` is injected with
  `chrome.scripting.executeScript` only after a user gesture on that tab grants
  `activeTab`. A click inside the side panel does not grant it, so the panel's
  "Attach this page" button fails politely on a tab the extension was not
  invoked on. `chrome://`, extension pages, `file:` and the web stores are
  refused before injection.
- **Page text is untrusted data.** It travels as the `pageContext` field of
  the `/v1/chat` start payload, never inside the prompt. The backend
  (`backend/lunora/chat/lib/page-context.ts`) validates it, JSON-encodes it
  inside `<web_page>` delimiters with `<` escaped, and tells the model to treat
  it as evidence only, never as instructions.
- **CSP** (build only): `script-src 'self' 'wasm-unsafe-eval'`,
  `object-src 'none'`, and `connect-src` limited to the three origins.

## Configuration

Copy `.env.example` to `.env`. `VITE_*` values are baked in at build time, and
`manifest.config.ts` derives host permissions and `connect-src` from them.

The backend delivers sign-in codes only to listed redirect URIs
(`TRUSTED_EXTENSION_REDIRECT_URIS`, see [Sign-in](#sign-in-without-cookies)).
Unset, it lists the shipped Firefox add-on only. The Chrome build's URI is
`https://<extension id>.chromiumapp.org/`. The same list holds the desktop
(`neore://auth/callback`) and mobile (`neore-mobile://auth/callback`) callbacks
when those apps sign in, and a value replaces the whole list, so add the Chrome
URI to whatever is set. Unset before, list the Firefox URI beside it:

```dotenv
TRUSTED_EXTENSION_REDIRECT_URIS=https://<extension id>.chromiumapp.org/,https://c64d88ed4645bb5915bc267506fbc3dcd4a1da90.extensions.allizom.org/
```

`pnpm dev:setup` asks for the unpacked id and writes that value when the list
is unset, and moves the id of a retired `TRUSTED_EXTENSION_ORIGINS` into the list.

### A stable extension id for development

An unpacked Chrome extension's id is derived from the folder it was loaded
from, so a teammate — or you, after moving the checkout — gets a different id,
and every sign-in fails until `TRUSTED_EXTENSION_REDIRECT_URIS` is updated. Pin
it with the manifest's `key` field, the base64 public key (no PEM header) of a
key pair you generate once and keep:

```bash
openssl genrsa 2048 > dev-key.pem          # keep private; never commit it
openssl rsa -in dev-key.pem -pubout -outform DER | base64 -w0   # → key
```

Add the output as `key: '<base64>'` to the object `manifest.config.ts` returns,
reload the unpacked extension, and put the id `chrome://extensions` now shows
into `TRUSTED_EXTENSION_REDIRECT_URIS`. The key is public — it only fixes the
id. A Web Store build does not need it: the store assigns the id.

## Commands

```bash
pnpm build          # Chrome: tsc -b && vite build → dist/ and release/crx-*.zip
pnpm build:firefox  # Firefox: → dist-firefox/ and release/firefox-*.zip (upload this one to AMO)
pnpm test           # vitest (jsdom): extraction, budgeting, stream buffering, live replies, manifests, sign-in
pnpm lint:types
```

Chrome: load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
`dist-firefox/manifest.json`. The add-on id is fixed
(`browser_specific_settings.gecko.id`), so a temporary install keeps the same
sign-in redirect URI.

## Firefox

One source tree, two manifests: `src/manifest/build-manifest.ts` produces both
(tested in `build-manifest.test.ts`), selected by `TARGET_BROWSER=firefox`.
Firefox gets `background.scripts` (it has no MV3 service worker),
`sidebar_action` instead of `side_panel`, and
`browser_specific_settings.gecko` with the add-on id, `strict_min_version`
140 and the `data_collection_permissions` AMO requires. Context menus, "Chat
with this page", the quick prompts and both shortcuts behave the same; the
background script opens the sidebar with `sidebarAction.open()` (like
`sidePanel.open()`, only from the user-action handler, synchronously).

## Sign-in without cookies

Both builds sign in the same way, through an app grant, and neither uses the web
app's session cookie: the server must tell the extension's sends from the web
app's, and every Firefox install has its own random `moz-extension://<uuid>`
origin anyway. No extension origin is listed on the backend, and none needs to be:

- Requests from extension pages to hosts in `host_permissions` are made
  "without cross-origin restrictions" ([MDN, host_permissions][hp]), so CORS
  never applies to them.
- The extension sends no cookie — `credentials: 'omit'` on its own requests
  and on the Lunora client's (`src/lib/lunora-client.ts`), bearer tokens only —
  and the backend strips the cookie off any request from an extension origin
  (`backend/src/extension-cookie.ts`), so it could not ride the web session if
  it tried.

The token comes from an authorization-code flow with PKCE through
[`identity.launchWebAuthFlow`][wf] (`src/lib/extension-grant.ts`, server side
`backend/lunora/auth/extension-grant.ts`):

1. The extension makes a PKCE verifier and opens `APP_URL/auth/extension` with
   its S256 challenge, `identity.getRedirectURL()` and a random `state`.
2. The user signs in on the web app — any method it offers — and clicks
   **Connect**. The backend mints a one-time code (60 s, stored hashed) bound to
   the user, the challenge and the redirect URI, and the page redirects there.
   The browser intercepts that URL and hands it to the extension without loading it.
3. The extension posts code + verifier to `/extension/auth/exchange`. The code
   is consumed atomically before any check, so a replay, an expired code, a
   wrong verifier or a different redirect URI all fail and all burn it. Success
   creates a better-auth session; its token is kept in `storage.local`.
4. `/extension/auth/token` trades that session token for the usual short-lived
   JWT; `/extension/auth/revoke` signs out. The session shows in the user's
   session list, and ending it there signs the extension out: the next token
   request answers 401, the grant is dropped and the panel shows the sign-in page.

A Chrome install from before this flow held no grant. On the update,
`runtime.onInstalled` marks it (`migrateFromCookieSession`), and the sign-in
page says once why it is back and offers **Connect**.

The only secret ever in a URL is the one-time code, and it is useless without
the verifier, which never leaves the extension.

The backend only delivers codes to listed redirect URIs
(`TRUSTED_EXTENSION_REDIRECT_URIS`). Unset, it lists the shipped Firefox
add-on's (`https://<sha1 of the gecko id>.extensions.allizom.org/`). A deploy
that ships the Chrome build lists its store id's `https://<id>.chromiumapp.org/`
beside it; a value replaces the whole list, desktop and mobile callbacks
included, so keep every entry already set. The one-liner for another gecko id is
in `backend/.dev.vars.example`; `none` turns sign-in off. These URIs are safe to
send a code to because a browser intercepts one only for the extension whose id
it derives from, and each store signs one extension per id, so a code sent there
cannot reach a web page or another extension.

The desktop/mobile shell reuses this grant with the redirect URI
`neore://auth/callback` (see `desktop-and-mobile-apps.md`). That URI is opt-in only,
never part of the default, and is NOT browser-intercepted: any local app can
register the scheme, so only the PKCE verifier protects its codes, and they can
only become a cookie session through `/api/auth/client-grant/cookie`.

The user can withhold or revoke host permissions (Firefox, and Chrome's site
access); the sign-in button requests them first (`permissions.request`), since without them the backend is
no longer CORS-exempt.

[hp]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions
[wf]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity
