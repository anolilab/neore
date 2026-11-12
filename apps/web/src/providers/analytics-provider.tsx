import { useEffectivePermissions } from "@c15t/react";
import type { PostHog, PostHogConfig, PostHogInterface } from "posthog-js";
import type { FC, PropsWithChildren } from "react";
import { useEffect, useState } from "react";

import { reportFirstNativeLaunch } from "@/lib/analytics/first-native-launch";
import { getPostHog, loadPostHog, PostHogClientContext, takePendingPostHogReset } from "@/lib/analytics/posthog-client";
import { redactPromptFromEvent } from "@/lib/analytics/redact-prompt";

// The consent state PostHog should follow. `PostHogConsentSync` is a child of `AnalyticsProvider`, so its first
// effect runs before `posthog.init`; the `loaded` callback applies whatever arrived before then.
const consentState: { measurement?: boolean } = {};

const applyMeasurementConsent = (posthog: PostHogInterface, granted: boolean): void => {
    if (granted) {
        posthog.opt_in_capturing();
        // A launch that happened before consent is reported now; its stored flag keeps it from repeating.
        reportFirstNativeLaunch();
    } else {
        posthog.opt_out_capturing();
    }
};

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
        consentState.measurement = measurement;

        const posthog = getPostHog();

        if (posthog?.__loaded) {
            applyMeasurementConsent(posthog, measurement);
        }
    }, [measurement]);

    return null;
};

/** PostHog's options that do not depend on the session. */
export const POSTHOG_OPTIONS = {
    // A prompt link's text, and every address's fragment, never leave the browser in an event (`lib/analytics/redact-prompt.ts`).
    before_send: redactPromptFromEvent,
    capture_pageview: true,
    // PostHog will not set any cookies until the user has given consent
    cookieless_mode: "on_reject",
    // A guest link carries its bearer token in the fragment (`/guest#<token>`): PostHog keeps no address's fragment, not in
    // the cookie or storage it writes (`$initial_person_info`, session properties) nor in an event. `before_send` stays the backstop.
    disable_capture_url_hashes: true,
    person_profiles: "always",
} as const satisfies Partial<PostHogConfig>;

/** PostHog's `loaded` callback: applies the consent state that arrived before `posthog.init` finished. */
export const onPostHogLoaded = (ph: PostHogInterface): void => {
    if (import.meta.env.DEV) {
        // In development, opt in for debugging
        ph.opt_in_capturing();
        ph.debug();
    }

    if (consentState.measurement !== undefined) {
        applyMeasurementConsent(ph, consentState.measurement);
    }

    // Here, not in an effect: AnalyticsProvider wraps the app, so child effects run before PostHog loads.
    reportFirstNativeLaunch();
};

const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    // Provided once initialised; until then (and while its chunk cannot load) the app runs without analytics.
    const [client, setClient] = useState<PostHog | undefined>(undefined);

    useEffect(() => {
        if (import.meta.env.DEV || !globalThis || !import.meta.env.VITE_POSTHOG_API_KEY || !import.meta.env.VITE_POSTHOG_HOST) {
            return undefined;
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

        let isCancelled = false;

        // Initialize PostHog with cookieless mode for GDPR compliance
        // PostHog will operate in cookieless mode until consent is granted
        const start = async (): Promise<void> => {
            const posthog = await loadPostHog();

            if (isCancelled) {
                return;
            }

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
                ...POSTHOG_OPTIONS,
                loaded: onPostHogLoaded,
            });

            // Signed out while the chunk loaded, on a page that has not reloaded: drop the bootstrapped identity too.
            if (takePendingPostHogReset()) {
                posthog.reset();
            }

            setClient(posthog);
        };

        // A chunk that never loaded (retries exhausted, e.g. offline) is tried again once the window is back online.
        const attempt = (): void => {
            start().catch(() => {
                if (!isCancelled) {
                    globalThis.addEventListener("online", attempt, { once: true });
                }
            });
        };

        attempt();

        return () => {
            isCancelled = true;
            globalThis.removeEventListener("online", attempt);
        };
    }, []);

    return <PostHogClientContext value={client}>{children}</PostHogClientContext>;
};

export default AnalyticsProvider;
