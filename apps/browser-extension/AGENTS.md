# BROWSER EXTENSION — AGENT NOTES

The rules for working in `apps/browser-extension/`. The protocol and the reasoning are in this folder's `README.md`.

## SIGN-IN

- Both builds (Chrome, Firefox) sign in through the app grant only: `identity.launchWebAuthFlow` → `/extension/auth/exchange` → grant token in `storage.local` → `/extension/auth/token` for the bearer (`src/lib/extension-grant.ts`). Never add a cookie path back: the server must tell the extension's sends from the web app's.
- Every request to our origins sends no cookie: `credentials: "omit"` on our fetches, and the Lunora client gets a `fetch` that forces it (`src/lib/lunora-client.ts`), since it asks for `"include"` on its own. The backend strips the cookie off extension-origin requests anyway (`backend/src/extension-cookie.ts`).
- No host permission for the app origin: the extension only opens it in the sign-in window.
- A 401 from `/extension/auth/token` drops the grant (revoked or expired); sign-out revokes it server side, then forgets it even if offline.
- A Chrome install updated from the cookie build is told once to connect (`migrateFromCookieSession` on `runtime.onInstalled`, `neore.reconnectNeeded`), only when the old build's Lunora read cache holds something (`hasCookieBuildReads`): that build queried only when signed in. Keep the migration mark (`neore.authMigration`) so it runs once per install.
- A Chrome build signs in only when the backend lists `https://<id>.chromiumapp.org/` in `TRUSTED_EXTENSION_REDIRECT_URIS`. That one list also holds the desktop and mobile callbacks, and a value replaces it whole: add the Chrome URI to what is set, and list the Firefox URI when it was unset.
- Live queries: the socket signs in with a ticket minted for the bearer (`wireLiveSocket`, `@neore/client-runtime`); no cookie rides it.
- Every bearer goes to `lunora.setAuthToken(token, userId)` (`src/lib/auth-token-sync.ts`): without the subject a refresh reads as another user and the offline queue is dropped. `createAuthTokenSync` clears the bearer only on sign-out or another account; a new grant for the same user swaps it.
- The bearer cache and anything written after a round trip are keyed to the grant: a refresh or revoke that answers after another sign-in never touches the newer grant.
