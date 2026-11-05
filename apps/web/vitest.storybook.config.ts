import { join } from "node:path";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import storybookViteConfig from "./.storybook/vite.config.ts";

/**
 * Every story as a test, in Chromium: it must render without throwing, its `play` function
 * must pass, and axe must find no violation (`a11y.test: "error"` in `.storybook/preview.tsx`).
 *
 * Each story runs once per mode below. `.storybook/preview.tsx` reads `VITE_STORYBOOK_MODE`
 * into its starting globals, so a contrast failure in dark mode or under an accent preset, a
 * layout that throws on a phone, or one that breaks right to left fails like any other. The
 * time zone and locale are pinned, as the clock is (`src/storybook/clock.ts`).
 *
 * Named apart from `vitest.config.ts` so the root workspace glob does not pull it into
 * `pnpm vis run test`.
 */
const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

const MODES = [
    { mode: { theme: "light" }, name: "light", viewport: DESKTOP },
    { mode: { accent: "violet", theme: "dark" }, name: "dark-violet", viewport: DESKTOP },
    { mode: { theme: "light" }, name: "mobile", viewport: MOBILE },
    { mode: { direction: "rtl", theme: "dark" }, name: "rtl", viewport: DESKTOP },
] as const;

export default mergeConfig(
    storybookViteConfig,
    defineConfig({
        test: {
            projects: MODES.map(({ mode, name, viewport }) => {
                return {
                    define: { "import.meta.env.VITE_STORYBOOK_MODE": JSON.stringify(JSON.stringify(mode)) },
                    extends: true,
                    plugins: [storybookTest({ configDir: join(import.meta.dirname, ".storybook") })],
                    test: {
                        browser: {
                            enabled: true,
                            headless: true,
                            instances: [{ browser: "chromium" }],
                            provider: playwright({ contextOptions: { locale: "en-US", timezoneId: "UTC" } }),
                            viewport,
                        },
                        name: `storybook:${name}`,
                    },
                };
            }),
        },
    }),
);
