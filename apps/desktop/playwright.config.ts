import { defineConfig } from "@playwright/test";

export default defineConfig({
    reporter: "list",
    testDir: "./e2e",
    timeout: 60_000,
    // Electron runs one app at a time; parallel workers would fight over the single-instance lock.
    workers: 1,
});
