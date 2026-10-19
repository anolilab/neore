/**
 * The redirect URI the app signs in with. It is the one value the sign-in flow
 * depends on, so it lives here and nowhere else.
 *
 * BLOCKED ON AN OWNER DECISION: the backend's `TRUSTED_EXTENSION_REDIRECT_URIS`
 * parser (backend/lunora/lib/extension-origins.ts) accepts only the browser
 * extension redirects today. Before sign-in can work, the backend must:
 *   1. accept this exact URI as an opt-in entry in that parser,
 *   2. return a session token from `/extension/auth/exchange` for it,
 *   3. route it down the token path in apps/web/src/routes/auth/extension.tsx
 *      (not the native cookie path that `neore://auth/callback` takes).
 * Until then the exchange is refused and the sign-in screen shows that error.
 */
export const MOBILE_REDIRECT_URI = "neore-mobile://auth/callback";
