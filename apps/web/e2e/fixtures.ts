/**
 * E2E Test Fixtures
 *
 * Centralized test data constants for e2e tests. These users and data are
 * seeded before the e2e test suite runs via the global setup.
 *
 * The seed process calls Better Auth's sign-up API directly, which also
 * triggers Lunora after-create hooks to initialize userSettings and
 * aiUserPreferences records automatically.
 */

import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Test Users
// ---------------------------------------------------------------------------

export const TEST_USER = {
    email: "e2e-test@neore.test",
    name: "E2E Test User",
    password: "TestPassword123!",
} as const;

export const TEST_ADMIN = {
    email: "e2e-admin@neore.test",
    name: "E2E Admin User",
    password: "AdminPassword456!",
} as const;

/**
 * TEST_USER's signed-in browser state, written once per run by `auth.setup.ts`
 * and loaded with `test.use({ storageState })`. Sign-in is rate-limited to 3
 * per IP until a 10s quiet gap (`backend/lunora/auth.ts`), and the whole suite
 * shares one IP, so signing in through the form before every test that only
 * needs a session tripped 429s. Gitignored: it holds a live session cookie.
 */
export const TEST_USER_STATE = fileURLToPath(new URL(".auth/test-user.json", import.meta.url));

// ---------------------------------------------------------------------------
// URLs (match .env-example defaults for local development)
// ---------------------------------------------------------------------------

export const APP_BASE_URL = process.env.VITE_SITE_URL || "http://localhost:5173";
export const LUNORA_URL = process.env.VITE_LUNORA_URL || "http://localhost:8788";

/**
 * Better Auth API base path. Auth endpoints are served by Lunora HTTP
 * actions at `LUNORA_URL/api/auth/*`.
 */
export const AUTH_API_BASE = `${LUNORA_URL}/api/auth`;

// Safety: prevent e2e tests from accidentally running against production
if (LUNORA_URL.includes("lunora.cloud") || LUNORA_URL.includes("lunora.site")) {
    throw new Error(
        `[e2e] Refusing to run against a production Lunora URL: ${LUNORA_URL}\nSet VITE_LUNORA_URL to a local dev URL (e.g. http://localhost:8788).`,
    );
}

// ---------------------------------------------------------------------------
// Test Thread / Chat data
// ---------------------------------------------------------------------------

export const TEST_THREAD = {
    messages: [
        {
            role: "user" as const,
            text: "Hello, this is a test message for e2e testing.",
        },
        {
            role: "assistant" as const,
            text: "Hello! I'm here to help with your e2e tests. How can I assist you today?",
        },
    ],
    model: "openai:gpt-4o-mini",
    title: "E2E Test Thread",
} as const;

// ---------------------------------------------------------------------------
// Auth paths (must match the AuthCard view → route mapping)
// ---------------------------------------------------------------------------

export const AUTH_PATHS = {
    forgotPassword: "/auth/forgot-password",
    signIn: "/auth/sign-in",
    signUp: "/auth/sign-up",
    twoFactor: "/auth/two-factor",
} as const;

export const PROTECTED_PATHS = {
    chat: "/chat",
    dashboard: "/dashboard",
    settings: "/dashboard/settings/app/personalization",
} as const;

export const PUBLIC_PATHS = {
    landing: "/",
    models: "/models",
} as const;
