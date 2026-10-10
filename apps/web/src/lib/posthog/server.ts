import env from "@/lib/env";

// Only import posthog-node on the server. Held on an object so the memoised
// values can be filled in from inside the lazy loaders below.
const cache: {
    client: InstanceType<typeof import("posthog-node").PostHog> | null;
    PostHog: typeof import("posthog-node").PostHog | null;
} = { client: null, PostHog: null };

// Lazy load posthog-node to prevent client bundling
const getPostHogClass = async (): Promise<typeof import("posthog-node").PostHog | null> => {
    if (globalThis.window !== undefined) {
        return null; // Don't load on client
    }

    if (cache.PostHog) {
        return cache.PostHog;
    }

    try {
        const posthogModule = await import("posthog-node");

        cache.PostHog = posthogModule.PostHog;

        return cache.PostHog;
    } catch {
        return null;
    }
};

/**
 * Get or create a PostHog Node.js client instance
 * This is used for server-side feature flag evaluation.
 */
export const getPostHogClient = async (): Promise<InstanceType<typeof import("posthog-node").PostHog> | null> => {
    // Only initialize if we have the required environment variables
    if (!env.VITE_POSTHOG_API_KEY || !env.VITE_POSTHOG_HOST) {
        return null;
    }

    // Return existing client if already initialized
    if (cache.client) {
        return cache.client;
    }

    // Lazy load PostHog class
    const PostHogClass = await getPostHogClass();

    if (!PostHogClass) {
        return null;
    }

    // Initialize PostHog client for server-side use
    cache.client = new PostHogClass(env.VITE_POSTHOG_API_KEY, {
        // Flush immediately for server-side usage
        flushAt: 1,
        flushInterval: 0,
        // Flags are awaited by every page render before the first byte goes
        // out (root `beforeLoad`). The SDK default is 3s; past 1s a render
        // proceeds with no flags, which is what a PostHog outage looks like anyway.
        featureFlagsRequestTimeoutMs: 1000,
        host: env.VITE_POSTHOG_HOST,
        // Personal API key is optional but recommended for local feature flag evaluation
        // It should be set via POSTHOG_PERSONAL_API_KEY environment variable
        ...(process.env.POSTHOG_PERSONAL_API_KEY && {
            personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
        }),
    });

    return cache.client;
};

/**
 * Get distinct ID from PostHog cookie.
 */
export const getDistinctIdFromCookie = (cookieHeader: string | null, posthogKey: string): string | null => {
    if (!cookieHeader) {
        return null;
    }

    const cookieName = `ph_${posthogKey}_posthog`;
    const cookies: Record<string, string> = {};

    for (const cookie of cookieHeader.split(";")) {
        const [key, value] = cookie.trim().split("=", 2);

        if (key && value) {
            cookies[key] = decodeURIComponent(value);
        }
    }

    const phCookie = cookies[cookieName];

    if (!phCookie) {
        return null;
    }

    try {
        const parsed = JSON.parse(phCookie) as { distinct_id?: string };

        return parsed.distinct_id ?? null;
    } catch {
        return null;
    }
};

/**
 * Get all feature flags for a given distinct ID.
 */
export const getFeatureFlags = async (distinctId: string): Promise<Record<string, boolean | string> | null> => {
    const client = await getPostHogClient();

    if (!client) {
        return null;
    }

    try {
        const flags = await client.getAllFlags(distinctId);

        return flags;
    } catch (error) {
        console.error("Failed to fetch feature flags from PostHog:", error);

        return null;
    }
};
