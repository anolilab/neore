/**
 * PostHog tracking utility.
 *
 * Provides a typed `trackEvent` function and a `useTrack` hook that
 * automatically respects the user's consent preferences.
 */
import { posthog } from "posthog-js";
import { useCallback } from "react";

import type { AnalyticsEvent, AnalyticsEventMap } from "./events";

/**
 * Fire a PostHog event if the SDK is initialised and the user has
 * not opted out of capturing.
 */
export const trackEvent = <E extends AnalyticsEvent>(event: E, properties: AnalyticsEventMap[E]): void => {
    // posthog-js is a singleton – if it was never initialised (e.g. in dev
    // mode or when the env-var is missing) the `__loaded` flag will be falsy.
    if (!posthog.__loaded) {
        return;
    }

    // Respect consent – PostHog will silently no-op when opted-out, but we
    // guard here to keep the intent explicit.
    if (posthog.has_opted_out_capturing()) {
        return;
    }

    posthog.capture(event, properties as Record<string, unknown>);
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
