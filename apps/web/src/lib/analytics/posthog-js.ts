/**
 * `posthog-js`, behind its own dynamic entry (`loadPostHog` in `posthog-client.ts` imports this file, never the package).
 * A module of ours gets a key in `.vite/manifest.json`, which a bare package import does not, so the offline shell can
 * precache it (`OFFLINE_SHELL_CHUNKS` in `scripts/generate-sw.mjs`): its persisted flags gate UI an offline start needs.
 */
export { posthog } from "posthog-js";
