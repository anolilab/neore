import { useEffectivePermissions } from "@c15t/react";
import { posthog } from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FC, PropsWithChildren } from "react";
import { useEffect } from "react";

import { reportFirstNativeLaunch } from "@/lib/analytics/first-native-launch";

/**
 * Apply the effective consent permissions to PostHog.
 *
 * Mounted inside the live `<ConsentProvider>` in `routes/__root.tsx`. c15t 3's callbacks no longer fire at
 * startup, so this follows the permissions hook instead: it runs once with the stored (or default) state and
 * again on every change, as v2's `onConsentSet` did.
 */
export const PostHogConsentSync: FC = () => {
    const { measurement } = useEffectivePermissions();

    useEffect(() => {
        if (measurement) {
            posthog.opt_in_capturing();
            // A launch that happened before consent is reported now; its stored flag keeps it from repeating.
            reportFirstNativeLaunch();
        } else {
            posthog.opt_out_capturing();
        }
    }, [measurement]);

    return null;
};

const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    useEffect(() => {
        if (import.meta.env.DEV || !globalThis || !import.meta.env.VITE_POSTHOG_API_KEY || !import.meta.env.VITE_POSTHOG_HOST) {
            return;
        }

        // Get bootstrapped data from meta tag (injected by server)
        let flagData: Record<string, boolean | string> | undefined;
        let distinctId: string | undefined;

        if (globalThis.document) {
            const metaTag = document.querySelector('meta[name="posthog-data"]');

            if (metaTag) {
                try {
                    const data = JSON.parse(metaTag.getAttribute("content") ?? "{}") as {
                        distinctId?: string;
                        flags?: Record<string, boolean | string>;
                    };

                    distinctId = data.distinctId;
                    flagData = data.flags;
                } catch {
                    // Silently fail if parsing fails
                }
            }
        }

        // Initialize PostHog with cookieless mode for GDPR compliance
        // PostHog will operate in cookieless mode until consent is granted
        posthog.init(import.meta.env.VITE_POSTHOG_API_KEY, {
            api_host: import.meta.env.VITE_POSTHOG_HOST,
            // Bootstrap feature flags from server-side rendering
            bootstrap:
                distinctId && flagData
                    ? {
                          distinctID: distinctId,
                          featureFlags: flagData,
                          isIdentifiedID: false,
                      }
                    : undefined,
            capture_pageview: true,
            // PostHog will not set any cookies until the user has given consent
            cookieless_mode: "on_reject",
            loaded: (ph) => {
                // Avoid accidental tracking without consent until c15t has loaded
                if (ph.has_opted_out_capturing()) {
                    // PostHog is already opted out (default in cookieless_mode: 'on_reject')
                    // This ensures no tracking happens until consent is granted
                }

                if (import.meta.env && import.meta.env.DEV) {
                    // In development, opt in for debugging
                    ph.opt_in_capturing();
                    ph.debug();
                }

                // Here, not in an effect: AnalyticsProvider wraps the app, so child effects run before PostHog loads.
                reportFirstNativeLaunch();
            },
            person_profiles: "always",
        });
    }, []);

    return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};

export default AnalyticsProvider;
