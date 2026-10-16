import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import env from "@/lib/env";
import { getDistinctIdFromCookie, getFeatureFlags } from "@/lib/posthog/server";
import type { PostHogRequestData } from "@/lib/request-context";

/**
 * The PostHog identity and flags for the cookies of THIS request. The browser calls it when
 * the session changes, so route gates read the new account's flags before the routes reload.
 * Without a PostHog cookie there is no identity, so nothing is evaluated for the visitor.
 */
export const getClientPostHogState = createServerFn({ method: "GET" }).handler(async (): Promise<PostHogRequestData> => {
    const posthogKey = env.VITE_POSTHOG_API_KEY;

    if (!posthogKey || !env.VITE_POSTHOG_HOST) {
        return { distinctId: null, flags: {} };
    }

    const distinctId = getDistinctIdFromCookie(getRequest().headers.get("cookie"), posthogKey);

    if (!distinctId) {
        return { distinctId: null, flags: {} };
    }

    return { distinctId, flags: (await getFeatureFlags(distinctId)) ?? {} };
});
