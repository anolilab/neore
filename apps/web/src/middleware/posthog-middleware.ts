import { randomUUID } from "node:crypto";

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

    // Get distinct ID from cookie or generate a new one
    const cookieHeader = request.headers.get("cookie");
    let distinctId = getDistinctIdFromCookie(cookieHeader, env.VITE_POSTHOG_API_KEY);

    // If no distinct ID found, generate a temporary one
    // This will be replaced by PostHog on the client side
    if (!distinctId) {
        distinctId = randomUUID();
    }

    // `getFeatureFlags` never rejects (it logs and answers null).
    const flags = getFeatureFlags(distinctId).then((result) => result ?? {});

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
