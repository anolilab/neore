import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * The worker Storybook serves must be the one the installed `msw` ships. Every request a story
 * page makes, Vite's module fetches included, goes through it. msw 3 has no postinstall, so a bump
 * left 3.0.3's worker under msw 3.0.4: Chromium stopped it about five minutes into a run, and the
 * stories loading then failed with "Failed to fetch dynamically imported module" or timed out
 * (mswjs/msw#2801). After an msw bump, refresh it with `pnpm --filter @neore/web exec msw init`.
 */
describe("Storybook's mockServiceWorker.js", () => {
    it("is the worker of the installed msw", () => {
        // A checkout with CRLF conversion rewrites the served copy's line endings, not its content.
        const read = (file: string): string => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

        expect(read(resolve(import.meta.dirname, "../../.storybook/public/mockServiceWorker.js"))).toBe(read(require.resolve("msw/mockServiceWorker.js")));
    });
});
