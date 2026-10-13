const TRAILING_SLASH = /\/$/u;
const INGESTION_REGION_HOST = /^(https:\/\/(?:eu|us))\.i\./u;

/**
 * PostHog serves events from `eu.i.posthog.com` and its private API from `eu.posthog.com`.
 * `POSTHOG_HOST` names the first; the person-delete call needs the second. A host that is
 * not one of the two regions (a reverse proxy) is returned as given.
 */
export const posthogAppHost = (ingestionHost: string | undefined): string =>
    (ingestionHost?.trim() || "https://us.i.posthog.com").replace(TRAILING_SLASH, "").replace(INGESTION_REGION_HOST, "$1.");
