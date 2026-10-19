/**
 * The redirect URI the app signs in with. It is the one value the sign-in flow
 * depends on, so it lives here and nowhere else. Must match the backend's
 * `MOBILE_REDIRECT_URI` in backend/lunora/lib/extension-origins.ts exactly; the
 * backend admits it only when listed in `TRUSTED_EXTENSION_REDIRECT_URIS`.
 */
export const MOBILE_REDIRECT_URI = "neore-mobile://auth/callback";
