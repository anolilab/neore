import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to test the validation module in isolation, so we import it dynamically
// after setting up the env vars for each test.

const CORE_ENV = {
    ADMIN: "admin@test.com",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough",
    ENCRYPTION_KEY: "a]V2x!9Kp#mN7Qw$rF4hJ8dL0sY6bE3c", // 32+ chars
    ENVIRONMENT: "development",
    JWKS: '{"keys":[]}',
    SITE_URL: "http://localhost:5173",
};

const SERVICE_ENV = {
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    LLM_GATEWAY_SIGNING_SECRET: "gateway-signing-secret",
    MAIL_FROM: "test@test.com",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_BUCKET: "test-bucket",
    R2_ENDPOINT: "https://test.r2.cloudflarestorage.com",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_TOKEN: "test-token",
    RESEND_API_KEY: "re_test_key",
    RESEND_WEBHOOK_SECRET: "whsec_test",
    STORAGE_SIGNING_SECRET: "storage-signing-secret-at-least-32-chars",
};

const AI_PROVIDER_ENV = {
    FAL_API_KEY: "fal-key",
    GROQ_API_KEY: "groq-key",
    OPENROUTER_API_KEY: "or-key",
    REPLICATE_API_TOKEN: "replicate-token",
    REQUESTY_API_KEY: "requesty-key",
    XAI_API_KEY: "xai-key",
};

const TOOL_API_ENV = {
    AMADEUS_CLIENT_ID: "amadeus-id",
    AMADEUS_CLIENT_SECRET: "amadeus-secret",
    COINGECKO_API_KEY: "cg-key",
    E2B_API_KEY: "e2b-key",
    EXA_API_KEY: "exa-key",
    FIRECRAWL_API_KEY: "fc-key",
    GITHUB_TOKEN: "gh-token",
    GOOGLE_MAPS_API_KEY: "gm-key",
    OPENWEATHER_API_KEY: "ow-key",
    PARALLEL_API_KEY: "parallel-key",
    SPOTIFY_CLIENT_ID: "spotify-id",
    SPOTIFY_CLIENT_SECRET: "spotify-secret",
    SUPADATA_API_KEY: "supadata-key",
    TAVILY_API_KEY: "tavily-key",
    TMDB_API_KEY: "tmdb-key",
    VALYU_API_KEY: "valyu-key",
};

const ALL_ENV = { ...CORE_ENV, ...SERVICE_ENV, ...AI_PROVIDER_ENV, ...TOOL_API_ENV };

describe("envValidation — tiered validation", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("should pass validation with all env vars in production", async () => {
        const productionEnvironment = Object.entries({ ...ALL_ENV, ENVIRONMENT: "production" });

        for (const [key, value] of productionEnvironment) {
            vi.stubEnv(key, value);
        }

        const { default: validateEnv } = await import("./env-validation");
        const result = validateEnv();

        expect(result.BETTER_AUTH_SECRET).toBe(CORE_ENV.BETTER_AUTH_SECRET);
        expect(result.OPENROUTER_API_KEY).toBe(AI_PROVIDER_ENV.OPENROUTER_API_KEY);
        expect(result.TAVILY_API_KEY).toBe(TOOL_API_ENV.TAVILY_API_KEY);
    });

    it("validateEnv should not throw in production with missing tool keys (deferred to assertEnv)", async () => {
        const envWithoutTools = { ...CORE_ENV, ...SERVICE_ENV, ...AI_PROVIDER_ENV, ENVIRONMENT: "production" };

        for (const [key, value] of Object.entries(envWithoutTools)) {
            vi.stubEnv(key, value);
        }

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { default: validateEnv } = await import("./env-validation");
        const result = validateEnv();

        expect(result).toEqual({});
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("assertEnv should throw in production when tool API keys are missing", async () => {
        const envWithoutTools = { ...CORE_ENV, ...SERVICE_ENV, ...AI_PROVIDER_ENV, ENVIRONMENT: "production" };

        for (const [key, value] of Object.entries(envWithoutTools)) {
            vi.stubEnv(key, value);
        }

        const { assertEnv } = await import("./env-validation");

        expect(() => assertEnv()).toThrow("Environment validation failed");
    });

    it("assertEnv should memoize a successful validation across calls", async () => {
        const productionEnvironment = Object.entries({ ...ALL_ENV, ENVIRONMENT: "production" });

        for (const [key, value] of productionEnvironment) {
            vi.stubEnv(key, value);
        }

        const { assertEnv } = await import("./env-validation");
        const first = assertEnv();
        const second = assertEnv();

        expect(first).toBe(second);
        expect(first.BETTER_AUTH_SECRET).toBe(CORE_ENV.BETTER_AUTH_SECRET);
    });

    it("should succeed in development with only core env vars", async () => {
        for (const [key, value] of Object.entries(CORE_ENV)) {
            vi.stubEnv(key, value);
        }

        const { default: validateEnv } = await import("./env-validation");
        const result = validateEnv();

        // Core vars are set
        expect(result.BETTER_AUTH_SECRET).toBe(CORE_ENV.BETTER_AUTH_SECRET);
        expect(result.ENVIRONMENT).toBe("development");

        // Service, AI, and tool vars default to ""
        expect(result.RESEND_API_KEY).toBe("");
        expect(result.OPENROUTER_API_KEY).toBe("");
        expect(result.TAVILY_API_KEY).toBe("");
        expect(result.GOOGLE_CLIENT_ID).toBe("");
    });

    it("should preserve set AI provider keys in development", async () => {
        const developmentEnvironment = Object.entries({ ...CORE_ENV, OPENROUTER_API_KEY: "my-key" });

        for (const [key, value] of developmentEnvironment) {
            vi.stubEnv(key, value);
        }

        const { default: validateEnv } = await import("./env-validation");
        const result = validateEnv();

        expect(result.OPENROUTER_API_KEY).toBe("my-key");
        // Other AI keys default to ""
        expect(result.FAL_API_KEY).toBe("");
    });

    it("should return empty object during codegen (no BETTER_AUTH_SECRET)", async () => {
        // Simulate codegen: process.env exists but no BETTER_AUTH_SECRET
        const { default: validateEnv } = await import("./env-validation");
        const result = validateEnv();

        expect(result).toEqual({});
    });

    it("assertEnv should validate when process.env is a Proxy that hides keys (Proxy-env runtime)", async () => {
        // Some runtimes expose process.env as a Proxy: direct key access returns the value
        // but Object.keys returns []. Simulate by replacing process.env with such a proxy.
        const realEnv = { ...ALL_ENV, ENVIRONMENT: "production" };
        const originalEnv = process.env;
        const proxiedEnv = new Proxy(
            {},
            {
                get: (_, key) => (typeof key === "string" ? (realEnv as Record<string, string>)[key] : undefined),
                getOwnPropertyDescriptor: () => undefined,
                ownKeys: () => [],
            },
        );

        Object.defineProperty(process, "env", { configurable: true, value: proxiedEnv });

        try {
            const { assertEnv } = await import("./env-validation");
            const result = assertEnv();

            expect(result.BETTER_AUTH_SECRET).toBe(CORE_ENV.BETTER_AUTH_SECRET);
            expect(result.OPENROUTER_API_KEY).toBe(AI_PROVIDER_ENV.OPENROUTER_API_KEY);
        } finally {
            Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
        }
    });
});
