import { PostHog } from "posthog-react-native";

import type { PostHogConfig } from "./config";

/**
 * Builds the PostHog client with every automatic capture and fetch turned off, and
 * starts it opted out, so nothing but a crash the user has agreed to report reaches PostHog.
 * `defaultOptIn: false` alone still lets the core request feature flags on start, so those are turned off here.
 */
export const createPostHogClient = ({ apiKey, host }: PostHogConfig): PostHog =>
    new PostHog(apiKey, {
        captureAppLifecycleEvents: false,
        defaultOptIn: false,
        disableRemoteFeatureFlags: true,
        disableSurveys: true,
        errorTracking: { autocapture: false },
        host,
        preloadFeatureFlags: false,
    });
