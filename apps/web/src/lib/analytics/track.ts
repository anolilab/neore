/**
 * PostHog tracking utility.
 *
 * Provides a typed `trackEvent` function and a `useTrack` hook that
 * automatically respects the user's consent preferences.
 */
import { useCallback } from "react";

import type { AnalyticsEvent, AnalyticsEventMap } from "./events";
import { forgetPostHogIdentity, getPostHog } from "./posthog-client";

/**
 * Forget the identified user before a sign-out reload, so later events from this
 * browser are not attributed to the account that just left. Before PostHog has
 * initialised (its chunk loads after mount) the identity it stored is removed instead.
 */
export const resetAnalyticsIdentity = (): void => {
    const posthog = getPostHog();

    if (posthog?.__loaded) {
        posthog.reset();

        return;
    }

    if (import.meta.env.VITE_POSTHOG_API_KEY) {
        forgetPostHogIdentity(import.meta.env.VITE_POSTHOG_API_KEY);
    }
};

/**
 * Fire a PostHog event if the SDK is initialised and the user has
 * not opted out of capturing.
 */

export const trackEvent = <E extends AnalyticsEvent>(event: E, properties: AnalyticsEventMap[E]): boolean => {
    // posthog-js is a singleton – if it was never loaded or initialised (e.g. in dev
    // mode or when the env-var is missing) there is no client or its `__loaded` flag is falsy.
    const posthog = getPostHog();

    if (!posthog?.__loaded) {
        return false;
    }

    // Respect consent – PostHog will silently no-op when opted-out, but we
    // guard here to keep the intent explicit.
    if (posthog.has_opted_out_capturing()) {
        return false;
    }

    posthog.capture(event, properties as Record<string, unknown>);

    return true;
};

/**
 * Report an error the app caught and recovered from, as the error boundaries report theirs, under the same
 * initialisation and consent checks as `trackEvent`. `properties` say where it was caught; never user content.
 */
export const reportCaughtError = (error: unknown, properties: Record<string, string>): boolean => {
    const posthog = getPostHog();

    if (!posthog?.__loaded || posthog.has_opted_out_capturing()) {
        return false;
    }

    posthog.captureException(error, properties);

    return true;
};

/**
 * React hook that returns a stable `track` callback.
 *
 * ```tsx
 * const track = useTrack();
 * track("message_sent", { model: "gpt-4o", has_attachments: false, attachment_count: 0 });
 * ```
 */
export const useTrack = (): (<E extends AnalyticsEvent>(event: E, properties: AnalyticsEventMap[E]) => void) =>
    useCallback(<E extends AnalyticsEvent>(event: E, properties: AnalyticsEventMap[E]) => {
        trackEvent(event, properties);
    }, []);
