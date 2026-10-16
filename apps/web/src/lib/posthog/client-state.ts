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

/**
 * Bounded: a slow PostHog must not hold up the session change that is waiting for these flags.
 * On a timeout the visitor gets empty flags, as on any other failure.
 */
const FLAGS_DEADLINE_MS = 3000;

const withDeadline = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            work,
            new Promise<T>((resolve) => {
                timer = setTimeout(resolve, FLAGS_DEADLINE_MS, fallback);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export const getClientPostHogState = createServerFn({ method: "GET" }).handler(async (): Promise<PostHogRequestData> => {
    const posthogKey = env.VITE_POSTHOG_API_KEY;

    if (!posthogKey || !env.VITE_POSTHOG_HOST) {
        return { distinctId: null, flags: {} };
    }

    const distinctId = getDistinctIdFromCookie(getRequest().headers.get("cookie"), posthogKey);

    if (!distinctId) {
        return { distinctId: null, flags: {} };
    }

    return { distinctId, flags: (await withDeadline(getFeatureFlags(distinctId), null)) ?? {} };
});
