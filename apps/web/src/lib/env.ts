import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

// import { vite } from "@t3-oss/env-core/presets-zod"

const env = createEnv({
    client: {
        VITE_APP_TITLE: z.string().min(1).optional(),
        VITE_C15T_BACKEND_URL: z.url().optional(),
        // c15t Consent Management
        VITE_C15T_MODE: z.enum(["offline", "c15t"]).optional(),
        // GDPR Configuration
        VITE_DPO_EMAIL: z.email().optional(),
        VITE_DPO_NAME: z.string().min(1).optional(),
        /** LLM Gateway URL — required for all chat and embedding requests */
        VITE_LLM_GATEWAY_URL: z.url(),
        /** Lunora worker origin — serves both `/_lunora/rpc` and `/api/auth/*`. */
        VITE_LUNORA_URL: z.url(),
        // PostHog Configuration
        VITE_POSTHOG_API_KEY: z.string().optional(),
        VITE_POSTHOG_HOST: z.url().optional(),
        VITE_PRIVACY_POLICY_URL: z.url().optional(),

        VITE_SITE_URL: z.url(),
        // Cloudflare Turnstile CAPTCHA
        VITE_TURNSTILE_SITE_KEY: z.string().optional(),
    },

    /**
     * The prefix that client-side variables must have. This is enforced both at
     * a type-level and at runtime.
     */
    clientPrefix: "VITE_",

    /**
     * By default, this library will feed the environment variables directly to
     * the Zod validator.
     *
     * This means that if you have an empty string for a value that is supposed
     * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
     * it as a type mismatch violation. Additionally, if you have an empty string
     * for a value that is supposed to be a string with a default value (e.g.
     * `DOMAIN=` in an ".env" file), the default value will never be applied.
     *
     * In order to solve these issues, we recommend that all new projects
     * explicitly specify this option as true.
     */
    emptyStringAsUndefined: true,

    /**
     * What object holds the environment variables at runtime. This is usually
     * `process.env` or `import.meta.env`.
     */
    runtimeEnv: {
        ...import.meta.env,
        ...process.env,
    },

    server: {
        // PostHog Personal API Key (optional, for local feature flag evaluation)
        POSTHOG_PERSONAL_API_KEY: z.string().optional(),
        SERVER_URL: z.url().optional(),
    },

    // TODO: Recheck why this does not work
    // extends: [vite()],
});

export default env;
