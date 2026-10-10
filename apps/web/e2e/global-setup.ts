import type { FullConfig } from "@playwright/test";

import { AUTH_PATHS, PROTECTED_PATHS, PUBLIC_PATHS } from "./fixtures";

/**
 * Warm the dev server's module graph before any test runs.
 *
 * Playwright's `webServer` waits for one URL to answer, and Vite answers it long
 * before it has transformed the rest of the app — it optimises dependencies
 * lazily, per import graph, on first request for a route. So the first
 * client-side navigation into an untouched route can stall for far longer than
 * an assertion timeout while esbuild works.
 *
 * That is not hypothetical: after clearing `node_modules/.vite`, two navigation
 * tests that pass warm failed at the full 60s test timeout, with the click
 * landing and the destination never rendering. A CI runner starts cold every
 * time, so it would have been the normal case there and the flake nobody could
 * reproduce locally.
 *
 * Fetching each route here forces the transform while nothing is being asserted.
 */
const warm = async (baseURL: string): Promise<void> => {
    // Protected routes are included even though an anonymous fetch is redirected:
    // the server still resolves the route module, and `/chat` and `/dashboard` are
    // the heaviest in the app. Cold, they were exceeding the 60s test timeout.
    const routes = [...Object.values(PUBLIC_PATHS), ...Object.values(AUTH_PATHS), ...Object.values(PROTECTED_PATHS)];

    await Promise.all(
        routes.map(async (route) => {
            try {
                await fetch(new URL(route, baseURL));
            } catch {
                // A route that refuses to warm is not a setup failure — the test
                // that needs it will say so, and with a better message than this
                // could.
            }
        }),
    );
};

const globalSetup = async (config: FullConfig): Promise<void> => {
    const baseURL = config.projects[0]?.use.baseURL;

    if (baseURL) {
        await warm(baseURL);
    }
};

export default globalSetup;
