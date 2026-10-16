import { createMiddleware } from "@tanstack/react-start";

import env from "@/lib/env";
import { getDistinctIdFromCookie, getFeatureFlags } from "@/lib/posthog/server";

/**
 * Middleware to fetch PostHog feature flags on the server
 * and make them available to the client via context
 *
 * Only for page renders: the one reader is the root route's `beforeLoad`
 * (`readRequestContext`). Server functions and `/api/*` never read the flags,
 * and every client-side navigation calls a server function (`getSessionToken`),
 * so fetching there added a PostHog round trip to each of them for nothing.
 *
 * The flags are handed on as a PROMISE, not awaited here: `beforeLoad` awaits
 * them together with the session token, so a page render pays the slower of
 * the two round trips instead of their sum.
 */
const posthogMiddleware = createMiddleware({ type: "request" }).server(async ({ handlerType, next, pathname, request }) => {
    // Only fetch flags if PostHog is configured
    if (!env.VITE_POSTHOG_API_KEY || !env.VITE_POSTHOG_HOST || handlerType === "serverFn" || pathname.startsWith("/api/")) {
        return next();
    }

    // Only a distinct ID that PostHog itself stored in a cookie is used. PostHog stores it only
    // after consent (`cookieless_mode: "on_reject"`). A new visitor has none, so no ID is made up
    // and no flag request goes out: sending a generated ID to PostHog would identify them before
    // they consent.
    const cookieHeader = request.headers.get("cookie");
    const distinctId = getDistinctIdFromCookie(cookieHeader, env.VITE_POSTHOG_API_KEY);

    // `getFeatureFlags` never rejects (it logs and answers null).
    const flags = distinctId ? getFeatureFlags(distinctId).then((result) => result ?? {}) : Promise.resolve({});

    // Pass flags and distinct ID to the next middleware/route
    const result = await next({
        context: {
            posthog: {
                distinctId,
                flags,
            },
        },
    });

    return result;
});

export default posthogMiddleware;
