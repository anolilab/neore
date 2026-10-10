// Direct process.env reads. Eager destructuring through a validation function
// captured undefined values when validation bypassed (analysis/codegen) or failed
// at module load — even when process.env had real values — which broke downstream
// consumers like the auth plugin's static JWKS check. Strict validation lives
// in `lib/envValidation.ts#assertEnv`, called from request handlers.

const read = (key: string): string => process.env[key] ?? "";

export const ADMIN = read("ADMIN");
export const BETTER_AUTH_SECRET = read("BETTER_AUTH_SECRET");
/**
 * Set to `"false"` (or `"0"`) to accept open registration again. Anything else,
 * INCLUDING UNSET, keeps sign-up invite-only — the safe direction for a flag whose
 * failure mode is "anyone can register".
 *
 * Anonymous sign-in is unaffected either way; see `auth/lib/invite-only.ts`.
 */
export const SIGNUP_INVITE_ONLY = read("SIGNUP_INVITE_ONLY") !== "false" && read("SIGNUP_INVITE_ONLY") !== "0";
export const ENVIRONMENT = read("ENVIRONMENT");

export const RESEND_WEBHOOK_SECRET = read("RESEND_WEBHOOK_SECRET");

export const SITE_URL = read("SITE_URL");

/** Creem subscriptions (`billing/`). Checkout is off while the API key is unset. */
export const CREEM_API_KEY = read("CREEM_API_KEY");
export const CREEM_PRODUCT_PRO = read("CREEM_PRODUCT_PRO");
export const CREEM_PRODUCT_TEAM = read("CREEM_PRODUCT_TEAM");
export const CREEM_WEBHOOK_SECRET = read("CREEM_WEBHOOK_SECRET");
/** `true` targets test-api.creem.io (test-mode keys and products). */
export const CREEM_TEST_MODE = read("CREEM_TEST_MODE");
/** Comma-separated `chrome-extension://<id>` origins allowed to call auth. Empty = none. */
export const TRUSTED_EXTENSION_ORIGINS = read("TRUSTED_EXTENSION_ORIGINS");
/** Comma-separated `identity.launchWebAuthFlow` redirect URIs the extension sign-in may deliver a code to. Empty = the shipped Firefox add-on; `none` = off. */
export const TRUSTED_EXTENSION_REDIRECT_URIS = read("TRUSTED_EXTENSION_REDIRECT_URIS");
export const ENCRYPTION_KEY = read("ENCRYPTION_KEY");

export const GROQ_API_KEY = read("GROQ_API_KEY");
export const FAL_API_KEY = read("FAL_API_KEY");
export const OPENROUTER_API_KEY = read("OPENROUTER_API_KEY");
export const REQUESTY_API_KEY = read("REQUESTY_API_KEY");
export const REPLICATE_API_TOKEN = read("REPLICATE_API_TOKEN");

export const R2_BUCKET = read("R2_BUCKET");
export const R2_ENDPOINT = read("R2_ENDPOINT");
export const R2_ACCESS_KEY_ID = read("R2_ACCESS_KEY_ID");
export const R2_TOKEN = read("R2_TOKEN");
export const R2_SECRET_ACCESS_KEY = read("R2_SECRET_ACCESS_KEY");

export const GOOGLE_CLIENT_ID = read("GOOGLE_CLIENT_ID");
export const GOOGLE_CLIENT_SECRET = read("GOOGLE_CLIENT_SECRET");

/**
 * Optional sign-in providers — each is ON only when both its id and secret are
 * set (`auth.ts`), and the app shows its button only then
 * (`GET /api/auth/sign-in-methods`).
 *
 * GitHub's pair is `AUTH_GITHUB_*` rather than `GITHUB_*`: GitHub Actions
 * reserves secret names starting `GITHUB_`, and one name everywhere beats a
 * mapping in the deploy workflow.
 */
export const AUTH_GITHUB_CLIENT_ID = read("AUTH_GITHUB_CLIENT_ID");
export const AUTH_GITHUB_CLIENT_SECRET = read("AUTH_GITHUB_CLIENT_SECRET");
export const MICROSOFT_CLIENT_ID = read("MICROSOFT_CLIENT_ID");
export const MICROSOFT_CLIENT_SECRET = read("MICROSOFT_CLIENT_SECRET");
/** Entra tenant: `common` (default), `organizations`, `consumers`, or one tenant id — the last is the one to use for a company-only login. */
export const MICROSOFT_TENANT_ID = read("MICROSOFT_TENANT_ID");
/** Enterprise SSO: any OpenID Connect issuer (Okta, Auth0, Keycloak, Entra, Google Workspace …), discovered from `{issuer}/.well-known/openid-configuration`. */
export const OIDC_ISSUER = read("OIDC_ISSUER");
export const OIDC_CLIENT_ID = read("OIDC_CLIENT_ID");
export const OIDC_CLIENT_SECRET = read("OIDC_CLIENT_SECRET");
/** The button text, e.g. "Acme SSO". Defaults to "Single sign-on". */
export const OIDC_BUTTON_LABEL = read("OIDC_BUTTON_LABEL");

export const JWKS = read("JWKS");

export const E2B_API_KEY = read("E2B_API_KEY");

export const AMADEUS_CLIENT_ID = read("AMADEUS_CLIENT_ID");
export const AMADEUS_CLIENT_SECRET = read("AMADEUS_CLIENT_SECRET");
export const COINGECKO_API_KEY = read("COINGECKO_API_KEY");
export const EXA_API_KEY = read("EXA_API_KEY");
export const FIRECRAWL_API_KEY = read("FIRECRAWL_API_KEY");
export const GITHUB_TOKEN = read("GITHUB_TOKEN");
export const GOOGLE_MAPS_API_KEY = read("GOOGLE_MAPS_API_KEY");
export const OPENWEATHER_API_KEY = read("OPENWEATHER_API_KEY");
export const PARALLEL_API_KEY = read("PARALLEL_API_KEY");
export const SPOTIFY_CLIENT_ID = read("SPOTIFY_CLIENT_ID");
export const SPOTIFY_CLIENT_SECRET = read("SPOTIFY_CLIENT_SECRET");
export const SUPADATA_API_KEY = read("SUPADATA_API_KEY");
export const TAVILY_API_KEY = read("TAVILY_API_KEY");
export const TMDB_API_KEY = read("TMDB_API_KEY");
export const VALYU_API_KEY = read("VALYU_API_KEY");
export const TURNSTILE_SECRET_KEY = read("TURNSTILE_SECRET_KEY");

/**
 * The public half of the Turnstile pair. The backend never verifies with it —
 * it reads it only to know whether a client exists that can produce a token at
 * all. See `buildAuthOptions` in `auth.ts`.
 *
 * `VITE_TURNSTILE_SITE_KEY` is the fallback because that is the name the app
 * needs (Vite only exposes `VITE_`-prefixed vars to the client), and a local
 * `.env` shared by both should not have to spell the same key twice under two
 * names to get a working setup. The deploy binds the unprefixed one explicitly.
 */
export const TURNSTILE_SITE_KEY = read("TURNSTILE_SITE_KEY") || read("VITE_TURNSTILE_SITE_KEY");
export const XAI_API_KEY = read("XAI_API_KEY");

/**
 * This Worker's own public origin.
 *
 * One Lunora Worker serves `/_lunora/rpc`, `/api/auth/*` and the HTTP routes, so
 * there is only one origin and this is the same value as `PUBLIC_ORIGIN`. The
 * app's `VITE_LUNORA_SITE_URL` was deleted for this reason too.
 *
 * A separate site-URL variable was never bound on the backend — not
 * `alchemy.run.ts`, not `wrangler.jsonc`, not `dev-setup.js` — so reads of it
 * returned "" and the CORS entry it fed was dead code. Reading `PUBLIC_ORIGIN`
 * makes it live.
 *
 * Deliberately not in the validated schema: `server.ts` already treats it as
 * non-optional (it is the JWKS base, the signed-storage base and the scheduler's
 * callback origin), and a second required-ness check here would only add a
 * different error message for the same missing binding.
 */
export const PUBLIC_ORIGIN = read("PUBLIC_ORIGIN");
