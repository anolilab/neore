import { defineConfig, devices } from "@playwright/test";

/**
 * These are full-app tests: they navigate real URLs, submit real forms and
 * follow real redirects. They used to run under Vitest browser mode, which
 * renders components into an iframe and has no `page.goto`/`page.url` at all —
 * so every file failed on import or on the first navigation, and the suite had
 * never once executed. Playwright is the runner they were always written for.
 */

const APP_PORT = 5173;
const BACKEND_PORT = 8788;

const APP_URL = process.env.VITE_SITE_URL ?? `http://localhost:${String(APP_PORT)}`;
const BACKEND_URL = process.env.VITE_LUNORA_URL ?? `http://localhost:${String(BACKEND_PORT)}`;

// Same guard fixtures.ts carries: never let a run point at a deployed backend.
if (/lunora\.(?:cloud|site)/.test(BACKEND_URL)) {
    throw new Error(`[e2e] Refusing to run against a production backend: ${BACKEND_URL}`);
}

const GATEWAY_PORT = 8787;

export default defineConfig({
    expect: { timeout: 10_000 },
    forbidOnly: Boolean(process.env.CI),
    fullyParallel: false,
    globalSetup: "./e2e/global-setup.ts",
    outputDir: "./e2e/.results",
    projects: [
        // Signs the shared TEST_USER in once and saves its browser state (`e2e/auth.setup.ts`).
        { name: "setup", testMatch: /auth\.setup\.ts$/ },
        {
            dependencies: ["setup"],
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],

                /**
                 * `E2E_BROWSER_CHANNEL=chrome` runs the installed Google Chrome
                 * instead of Playwright's bundled build. For machines whose
                 * per-application firewall (OpenSnitch here) has never seen the
                 * freshly downloaded `chrome-headless-shell`: it silently drops
                 * its SYNs, even to loopback, so every `page.goto` times out
                 * with the dev servers answering curl just fine.
                 */
                ...(process.env.E2E_BROWSER_CHANNEL && { channel: process.env.E2E_BROWSER_CHANNEL }),
            },
        },
    ],
    reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "./e2e/.report" }]] : [["list"]],
    retries: process.env.CI ? 1 : 0,
    testDir: "./e2e",
    // Dot-prefixed files are local throwaway probes, never part of the suite.
    testIgnore: "**/.*",
    testMatch: /\.e2e\.test\.ts$/,

    /**
     * One spec at a time. Every backend call lands on the single `__root__`
     * Durable Object and the local D1's first access costs ~1s per request
     * (CLAUDE.md → Sharding and concurrency), so Playwright's default of half
     * the cores — 6 browsers here — queued first paints behind each other for
     * 5-10s, pushed agent runs 30s behind their queue delivery, and the
     * resulting abandoned requests surfaced as bursts of "Network connection
     * lost." Measured on one stack (2026-09-23): 6 workers passed 38, 36 and
     * 36 of 47 in ~7 min; one worker passed 47/47 in ~14 min. `E2E_WORKERS`
     * overrides it.
     */
    workers: Number(process.env.E2E_WORKERS) || 1,
    // Dev-mode SSR plus a cold RPC round trip makes the first load of a protected
    // route slow enough that 60s was not a bug signal, just a stopwatch.
    timeout: 120_000,
    use: {
        baseURL: APP_URL,

        /**
         * The app resolves locale from URL -> `?locale=` -> cookie ->
         * Accept-Language -> `en` (see `src/lib/intl/server.ts`). It ships English
         * and German, so an unpinned run inherits whatever the runner's Chromium
         * asks for and the assertions in here — written in English — fail against
         * German copy for no reason anyone would guess from the diff.
         *
         * Playwright's `locale` sets Accept-Language, which lands on step 5 and
         * resolves to `en`. Pin it rather than translating the assertions.
         */
        locale: "en-US",
        screenshot: "only-on-failure",
        trace: "on-first-retry",
        video: "off",
    },

    /**
     * All three servers, because the app alone renders sign-in forms that
     * cannot submit — every auth call is proxied to the backend — and the
     * backend alone cannot answer a chat message without the gateway.
     *
     * `reuseExistingServer` locally so a dev loop is not restarted underneath
     * you; never in CI, where a stale listener would silently test the wrong
     * build.
     */
    webServer: [
        {
            /**
             * In CI the backend runs under `scripts/dev-backend-watchdog.sh`,
             * which restarts it when wrangler's fatal "Network connection
             * lost." exit takes it down (CLAUDE.md → Local dev) — otherwise one
             * such exit fails every spec after it. Specs also wait for
             * `/api/health` before starting (`e2e/chat-helpers.ts`).
             */
            command: process.env.CI ? "scripts/dev-backend-watchdog.sh" : "pnpm --filter @neore/backend run dev",
            cwd: "../..",

            /**
             * `lunora dev` daemonises itself when it detects an AI agent in the
             * environment, so the foreground process exits immediately and any
             * supervisor — Playwright here — reads that as "webServer exited
             * early". `LUNORA_AGENT_MODE=0` keeps it attached.
             *
             * If it refuses to start with "Dev server already running (pid N)",
             * that is not a stale lockfile — it checks, and a dead pid in
             * `backend/.lunora/dev.json` is handled fine. Some earlier `lunora
             * dev` really is still up; `lunora dev stop` ends it.
             */
            env: { LUNORA_AGENT_MODE: "0" },
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
            url: `${BACKEND_URL}/api/health`,
        },
        {
            /**
             * The LLM gateway, which every model call goes through. Its
             * `.dev.vars` must carry `MOCK_LLM=1` — CI writes it, and locally
             * it is what lets the chat specs run without a provider key. Without
             * the flag the chat specs fail on the provider, not here.
             */
            command: "pnpm --filter llm-gateway dev",
            cwd: "../..",
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
            url: `http://localhost:${String(GATEWAY_PORT)}/health`,
        },
        {
            command: "pnpm --filter @neore/web run dev",
            cwd: "../..",
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
            url: `${APP_URL}/models`,
        },
    ],
});
