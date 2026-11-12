/**
 * PostHog tracking utility.
 *
 * Provides a typed `trackEvent` function and a `useTrack` hook that
 * automatically respects the user's consent preferences.
 */
import { useCallback } from "react";

import type { AnalyticsEvent, AnalyticsEventMap } from "./events";
import { captureException, forgetPostHogIdentity, getStartedPostHog, queueEvent } from "./posthog-client";

/**
 * Forget the identified user before a sign-out reload, so later events from this
 * browser are not attributed to the account that just left. Before PostHog has
 * started (its chunk loads after mount) the identity it stored is removed instead,
 * with what that account queued, and the client is reset when it starts.
 */
export const resetAnalyticsIdentity = (): void => {
    const posthog = getStartedPostHog();

    if (posthog) {
        posthog.reset();

        return;
    }

    if (import.meta.env.VITE_POSTHOG_API_KEY) {
        forgetPostHogIdentity(import.meta.env.VITE_POSTHOG_API_KEY);
    }
};

/**
 * Send a PostHog event unless the user has opted out of capturing.
 *
 * Returns `true` when the event went to PostHog now, `false` when it did not: either it is queued until PostHog
 * has started (`startPostHog`; its chunk loads after mount; `queueEvent` keeps it across a page load in this tab, and it is sent then
 * unless consent was refused meanwhile), or it is dropped (opted out, measurement refused, or analytics off in this
 * session). A caller that records "sent" (`reportFirstNativeLaunch`) acts only on `true`.
 */
export const trackEvent = <E extends AnalyticsEvent>(event: E, properties: AnalyticsEventMap[E]): boolean => {
    const posthog = getStartedPostHog();

    if (!posthog) {
        queueEvent(event, properties);

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
    const posthog = getStartedPostHog();

    if (!posthog) {
        // Queued with the boundaries' reports until PostHog has started, under the same consent rules.
        captureException(error, properties);

        return false;
    }

    if (posthog.has_opted_out_capturing()) {
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
