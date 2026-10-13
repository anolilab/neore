// eslint-disable-next-line import/no-namespace
import * as z from "zod/v4";

/* eslint-disable perfectionist/sort-objects */
const coreEnvSchema = z.object({
    BETTER_AUTH_SECRET: z.string().trim().min(1, "BETTER_AUTH_SECRET is required"),
    ENCRYPTION_KEY: z.string().trim().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
    SITE_URL: z.string().trim().min(1, "SITE_URL is required"),

    ADMIN: z.string().trim(),
    ENVIRONMENT: z.enum(["development", "preview", "production"]),

    JWKS: z.string().trim(),
});

const serviceEnvSchema = z.object({
    GOOGLE_CLIENT_ID: z.string().trim(),
    GOOGLE_CLIENT_SECRET: z.string().trim(),

    // Outbound mail (`email/mailer.ts`). `MAIL_FROM` is the sender for every
    // transport, dev capture included. Resend is only the fallback for a
    // deployment whose Email Service sending domain is not verified yet, so its
    // key may be empty; `alchemy.run.ts` refuses a production deploy without
    // `MAIL_FROM` rather than this failing every request.
    MAIL_FROM: z.string().trim(),
    RESEND_API_KEY: z.string().trim(),
    RESEND_WEBHOOK_SECRET: z.string().trim(),

    R2_ACCESS_KEY_ID: z.string().trim(),
    R2_BUCKET: z.string().trim(),
    R2_ENDPOINT: z
        .string()
        .trim()
        .min(1, "R2_ENDPOINT is required")
        .refine((url) => URL.canParse(url), { error: "R2_ENDPOINT must be a valid URL" }),
    R2_SECRET_ACCESS_KEY: z.string().trim(),
    R2_TOKEN: z.string().trim(),

    // The backend reaches the gateway over its service binding (`SERVICE_LLM_GATEWAY`,
    // no URL). This secret is the OTHER direction: the gateway's calls back here
    // (`/chat/chunks`, usage reports, key validation) and the stream tokens the
    // browser hands the gateway are HMAC-signed with it.
    LLM_GATEWAY_SIGNING_SECRET: z.string().trim().min(1, "LLM_GATEWAY_SIGNING_SECRET is required"),

    // Signs `ctx.storage` download URLs (`src/server.ts` → `.storage()`).
    // Unset, `server.ts` passes "" and every signed URL — file downloads,
    // attachments a model provider fetches — fails with "`signingSecret` is
    // required for getSignedUrl()" while the rest of the app looks healthy.
    STORAGE_SIGNING_SECRET: z.string().trim().min(32, "STORAGE_SIGNING_SECRET must be at least 32 characters"),
});

const aiProviderEnvSchema = z.object({
    FAL_API_KEY: z.string().trim(),
    GROQ_API_KEY: z.string().trim(),
    OPENROUTER_API_KEY: z.string().trim(),
    REQUESTY_API_KEY: z.string().trim(),
    XAI_API_KEY: z.string().trim(),
    REPLICATE_API_TOKEN: z.string().trim(),
});

const toolApiEnvSchema = z.object({
    AMADEUS_CLIENT_ID: z.string().trim(),
    AMADEUS_CLIENT_SECRET: z.string().trim(),
    COINGECKO_API_KEY: z.string().trim(),
    E2B_API_KEY: z.string().trim(),
    EXA_API_KEY: z.string().trim(),
    FIRECRAWL_API_KEY: z.string().trim(),
    GITHUB_TOKEN: z.string().trim(),
    GOOGLE_MAPS_API_KEY: z.string().trim(),
    OPENWEATHER_API_KEY: z.string().trim(),
    PARALLEL_API_KEY: z.string().trim(),
    SPOTIFY_CLIENT_ID: z.string().trim(),
    SPOTIFY_CLIENT_SECRET: z.string().trim(),
    SUPADATA_API_KEY: z.string().trim(),
    TAVILY_API_KEY: z.string().trim(),
    TMDB_API_KEY: z.string().trim(),
    VALYU_API_KEY: z.string().trim(),
});
/* eslint-enable perfectionist/sort-objects */

// PUBLIC_ORIGIN is read directly via process.env in `env.ts` rather than here.
// `server.ts` already fails loudly without it (it is the JWKS base, the
// signed-storage base and the scheduler's callback origin), so a second
// required-ness check would only produce a different message for one cause.
const optionalEnvSchema = z.object({
    APP_NAME: z.string().trim().optional(),
    AUTH_GITHUB_CLIENT_ID: z.string().trim().optional(),
    AUTH_GITHUB_CLIENT_SECRET: z.string().trim().optional(),
    BROWSERBASE_API_KEY: z.string().trim().optional(),
    BROWSERBASE_PROJECT_ID: z.string().trim().optional(),
    // Encrypts connector OAuth tokens; falls back to ENCRYPTION_KEY (own HKDF purpose) when unset.
    CONNECTOR_ENCRYPTION_KEY: z.string().trim().optional(),
    // Creem subscriptions (`billing/`). Without the API key, checkout and the
    // customer portal answer "Billing is not configured"; the webhook signs with
    // CREEM_WEBHOOK_SECRET. `CREEM_TEST_MODE=true` targets test-api.creem.io.
    CREEM_API_KEY: z.string().trim().optional(),
    CREEM_PRODUCT_PRO: z.string().trim().optional(),
    CREEM_PRODUCT_TEAM: z.string().trim().optional(),
    CREEM_TEST_MODE: z.string().trim().optional(),
    CREEM_WEBHOOK_SECRET: z.string().trim().optional(),
    DPO_EMAIL: z.string().trim().optional(),
    FEATUREBASE_API_KEY: z.string().trim().optional(),
    // Pre-registered OAuth clients for connectors whose MCP server has no dynamic
    // client registration. A connector without its client id shows "not configured".
    // Redirect URI to register: `${SITE_URL}/dashboard/settings/connectors/callback`.
    GITHUB_CONNECTOR_CLIENT_ID: z.string().trim().optional(),
    GITHUB_CONNECTOR_CLIENT_SECRET: z.string().trim().optional(),
    GOOGLE_CONNECTOR_CLIENT_ID: z.string().trim().optional(),
    GOOGLE_CONNECTOR_CLIENT_SECRET: z.string().trim().optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().trim().optional(),
    MICROSOFT_CLIENT_ID: z.string().trim().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().trim().optional(),
    MICROSOFT_TENANT_ID: z.string().trim().optional(),
    OIDC_BUTTON_LABEL: z.string().trim().optional(),
    OIDC_CLIENT_ID: z.string().trim().optional(),
    OIDC_CLIENT_SECRET: z.string().trim().optional(),
    // Checked by `parseOidcIssuer`, not here: this schema runs per request, and
    // a bad issuer must switch off OIDC alone rather than every route.
    OIDC_ISSUER: z.string().trim().optional(),
    POSTHOG_API_KEY: z.string().trim().optional(),
    POSTHOG_HOST: z.string().trim().optional(),
    POSTHOG_PERSONAL_API_KEY: z.string().trim().optional(),
    POSTHOG_PROJECT_ID: z.string().trim().optional(),
    // "false"/"0" opens registration; anything else (incl. unset) keeps it invite-only (`env.ts`).
    SIGNUP_INVITE_ONLY: z.string().trim().optional(),
    SLACK_CONNECTOR_CLIENT_ID: z.string().trim().optional(),
    SLACK_CONNECTOR_CLIENT_SECRET: z.string().trim().optional(),
    // Browser extension origins, comma-separated. Optional: unset means the
    // extension cannot sign in. Parsed to an exact list by
    // `lib/extension-origins.ts`, which drops wildcards and malformed entries.
    TRUSTED_EXTENSION_ORIGINS: z.string().trim().optional(),
    // `identity.launchWebAuthFlow` redirect URIs for the Firefox extension's sign-in,
    // comma-separated. Optional: unset means the shipped add-on's URI, `none` means
    // off. Parsed by
    // `lib/extension-origins.ts#parseTrustedExtensionRedirectUris`.
    TRUSTED_EXTENSION_REDIRECT_URIS: z.string().trim().optional(),
    TURNSTILE_SECRET_KEY: z.string().trim().optional(),
    // Web Push via `@lunora/notify` (`notifications/push-config.ts`). Optional:
    // without the pair, push is off and the in-app inbox works alone.
    // `scripts/dev-setup.js` generates one; VAPID_SUBJECT defaults to support@.
    VAPID_PRIVATE_KEY: z.string().trim().optional(),
    VAPID_PUBLIC_KEY: z.string().trim().optional(),
    VAPID_SUBJECT: z.string().trim().optional(),
    WOLFRAM_APP_ID: z.string().trim().optional(),
});

/**
 * The enterprise OIDC issuer as a URL, or why it cannot be used.
 *
 * Only `https:` is accepted: the discovery document names the JWKS the id
 * token is verified against, so a discovery fetched over plain http lets
 * anyone on the path swap in their own keys (or none) and assert any verified
 * email. A malformed value is refused the same way — `auth.ts` then leaves the
 * provider out and logs, instead of throwing while it builds the auth options
 * and taking email sign-in down with it.
 */
export const parseOidcIssuer = (value: string | undefined): { error: string; issuer: null } | { error: null; issuer: URL } => {
    const trimmed = value?.trim() ?? "";

    if (!URL.canParse(trimmed)) {
        return { error: "OIDC_ISSUER is not a valid URL", issuer: null };
    }

    const issuer = new URL(trimmed);

    if (issuer.protocol !== "https:") {
        return { error: "OIDC_ISSUER must use https:", issuer: null };
    }

    if (issuer.username || issuer.password || issuer.search || issuer.hash) {
        return { error: "OIDC_ISSUER must not carry credentials, a query or a fragment", issuer: null };
    }

    return { error: null, issuer };
};

const makeOptionalWithDefault = (schema: z.ZodObject<any>) =>
    z.object(
        Object.fromEntries(Object.keys(schema.shape).map((key) => [key, z.string().trim().optional().default("")])) as Record<
            string,
            z.ZodDefault<z.ZodOptional<z.ZodString>>
        >,
    );

const requiredEnvSchema = coreEnvSchema.merge(serviceEnvSchema).merge(aiProviderEnvSchema).merge(toolApiEnvSchema);

const developmentRequiredEnvSchema = coreEnvSchema
    .merge(makeOptionalWithDefault(serviceEnvSchema))
    .merge(makeOptionalWithDefault(aiProviderEnvSchema))
    .merge(makeOptionalWithDefault(toolApiEnvSchema));

const envSchema = requiredEnvSchema.merge(optionalEnvSchema).strip();
const developmentEnvSchema = developmentRequiredEnvSchema.merge(optionalEnvSchema).strip();

export type RequiredEnv = z.infer<typeof requiredEnvSchema>;
export type OptionalEnv = z.infer<typeof optionalEnvSchema>;
export type ValidatedEnv = z.infer<typeof envSchema>;

export const SERVICE_KEYS = Object.keys(serviceEnvSchema.shape);
export const AI_PROVIDER_KEYS = Object.keys(aiProviderEnvSchema.shape);
export const TOOL_API_KEYS = Object.keys(toolApiEnvSchema.shape);

/**
 * Every key the PRODUCTION schema demands be PRESENT, and every key it merely
 * tolerates. Exported for `alchemy.run.ts`, which has to bind the first list on
 * the backend Worker or the deploy comes up broken in a way no deploy-time check
 * catches.
 *
 * `assertEnv()` runs per request and picks the strict schema whenever
 * `ENVIRONMENT !== "development"`, and most of these are bare `z.string()` — so
 * a key that is ABSENT fails validation even though an EMPTY one passes. Thirty
 * of them were unbound, which is a 500 on every single request against a Worker
 * that deployed green.
 *
 * Read from the schemas rather than hand-copied, because the hand-copied version
 * is what drifted: adding a field to `toolApiEnvSchema` silently adds a required
 * binding, and nothing downstream would have noticed.
 *
 * `backend/deploy-env-bindings.test.ts` asserts `alchemy.run.ts` covers
 * REQUIRED_ENV_KEYS.
 */
export const REQUIRED_ENV_KEYS = Object.keys(requiredEnvSchema.shape);
export const OPTIONAL_ENV_KEYS = Object.keys(optionalEnvSchema.shape);

const logDevelopmentEnvSummary = (): void => {
    const configuredServices = SERVICE_KEYS.filter((key) => !!process.env[key]);
    const missingServices = SERVICE_KEYS.filter((key) => !process.env[key]);
    const configuredAI = AI_PROVIDER_KEYS.filter((key) => !!process.env[key]);
    const missingAI = AI_PROVIDER_KEYS.filter((key) => !process.env[key]);
    const configuredTools = TOOL_API_KEYS.filter((key) => !!process.env[key]);
    const missingTools = TOOL_API_KEYS.filter((key) => !process.env[key]);

    const lines: string[] = ["[ENV] Development mode — tiered validation active"];

    if (missingServices.length > 0) {
        lines.push(`[ENV] Services: ${configuredServices.length}/${SERVICE_KEYS.length} configured. Dev stubs active for: ${missingServices.join(", ")}`);
    } else {
        lines.push(`[ENV] Services: all ${SERVICE_KEYS.length} configured`);
    }

    if (configuredAI.length > 0) {
        lines.push(`[ENV] AI providers: ${configuredAI.length}/${AI_PROVIDER_KEYS.length} configured (${configuredAI.join(", ")})`);
    } else {
        lines.push(`[ENV] WARNING: No AI provider keys configured — chat will not work. Set at least OPENROUTER_API_KEY.`);
    }

    if (missingAI.length > 0 && configuredAI.length > 0) {
        lines.push(`[ENV] AI providers not configured: ${missingAI.join(", ")}`);
    }

    lines.push(`[ENV] Tool APIs: ${configuredTools.length}/${TOOL_API_KEYS.length} configured`);

    if (missingTools.length > 0) {
        lines.push(`[ENV] Tool APIs not configured: ${missingTools.join(", ")}`);
    }

    for (const line of lines) {
        console.info(line);
    }
};

const formatZodError = (error: z.ZodError): string =>
    // `error.issues` is the documented field; the `?? .errors` fallback was for
    // a zod version that never shipped in this tree.
    error.issues.map((issue) => `  ${issue.path.join(".") || "unknown"}: ${issue.message}`).join("\n");

// Some runtimes expose process.env as a Proxy that returns values on direct key access
// but reports no enumerable keys (Object.keys returns []). Zod's .parse() iterates
// the input via Object.keys, so passing process.env directly makes every required
// field look undefined. Snapshot known keys into a plain object before validating.
const snapshotEnv = (schema: z.ZodObject<any>): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};

    for (const key of Object.keys(schema.shape)) {
        const value = process.env[key];

        if (value !== undefined) {
            out[key] = value;
        }
    }

    return out;
};

const parseEnv = (): ValidatedEnv => {
    const isDevelopment = process.env["ENVIRONMENT"] === "development";
    const schema = isDevelopment ? developmentEnvSchema : envSchema;

    return schema.parse(snapshotEnv(schema)) as ValidatedEnv;
};

// Module-load entry point. Non-throwing: returns parsed env at runtime, or {} when
// vars aren't injected (codegen, module analysis). Strict validation is
// deferred to assertEnv() at request time.
const validateEnv = (): ValidatedEnv => {
    if (typeof process === "undefined" || !process.env) {
        return {} as ValidatedEnv;
    }

    if (!process.env["BETTER_AUTH_SECRET"]) {
        return {} as ValidatedEnv;
    }

    try {
        return parseEnv();
    } catch (error) {
        if (error instanceof z.ZodError) {
            console.warn(`[ENV] validation skipped at module load:\n${formatZodError(error)}`);
        } else {
            console.warn("[ENV] validation skipped at module load:", error instanceof Error ? error.message : String(error));
        }

        return {} as ValidatedEnv;
    }
};

let assertCache: ValidatedEnv | undefined;

// Runtime entry point. Memoized strict validation — call this from request handlers
// to fail fast on misconfigured deployments. Throws on the first call if any
// required var is missing or malformed; subsequent calls return the cached result.
export const assertEnv = (): ValidatedEnv => {
    if (assertCache) {
        return assertCache;
    }

    if (typeof process === "undefined" || !process.env) {
        throw new Error("[ENV] process.env is not available");
    }

    try {
        assertCache = parseEnv();
    } catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(`Environment validation failed:\n${formatZodError(error)}`, { cause: error });
        }

        throw error;
    }

    if (process.env["ENVIRONMENT"] === "development") {
        logDevelopmentEnvSummary();
    }

    return assertCache;
};

export default validateEnv;
