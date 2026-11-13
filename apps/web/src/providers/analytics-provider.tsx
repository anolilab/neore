import { useEffectivePermissions } from "@c15t/react";
import type { PostHog, PostHogConfig, PostHogInterface } from "posthog-js";
import type { FC, PropsWithChildren } from "react";
import { useEffect, useLayoutEffect, useState } from "react";

import { reportFirstNativeLaunch } from "@/lib/analytics/first-native-launch";
import {
    discardPendingCaptures,
    getMeasurementConsent,
    getPostHog,
    getStartedPostHog,
    loadPostHog,
    markPostHogRetrying,
    markPostHogUnavailable,
    PostHogClientContext,
    recordLandingPageview,
    setBootstrapFlags,
    setIdentityExpected,
    setMeasurementConsent,
    startPostHog,
} from "@/lib/analytics/posthog-client";
import { redactPromptFromEvent } from "@/lib/analytics/redact-prompt";

const applyMeasurementConsent = (posthog: PostHogInterface, granted: boolean): void => {
    if (granted) {
        posthog.opt_in_capturing();

        // A launch that happened before consent is reported now; its stored flag keeps it from repeating. Before
        // PostHog has started, `startPostHog` reports it, after any reset and the identity.
        if (getStartedPostHog()) {
            reportFirstNativeLaunch();
        }
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
        // `PostHogConsentSync` is a child of `AnalyticsProvider`, so this runs before `posthog.init`; the `loaded`
        // callback applies what arrived before then.
        setMeasurementConsent(measurement);

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
    // `$pageleave` would otherwise follow `capture_pageview` off ('if_capture_pageview').
    capture_pageleave: true,
    // `init` runs once the chunk has loaded, maybe on another page by then: the landing page is recorded at mount and
    // sent as the first `$pageview` instead (`recordLandingPageview`). `true` never captured later SPA navigations either.
    capture_pageview: false,
    // PostHog will not set any cookies until the user has given consent
    cookieless_mode: "on_reject",
    // A guest link carries its bearer token in the fragment (`/guest#<token>`): PostHog keeps no address's fragment, not in
    // the cookie or storage it writes (`$initial_person_info`, session properties) nor in an event. `before_send` stays the backstop.
    disable_capture_url_hashes: true,
    person_profiles: "always",
} as const satisfies Partial<PostHogConfig>;

/**
 * Real-user load timing (`lib/analytics/load-timing/report-load-timing.ts`). Its code and `web-vitals` load when this
 * provider mounts, alongside PostHog's chunk, so they stay out of the first-load bundle and are ready by the time PostHog
 * is; the browser buffers the entries it reads, and `trackEvent` queues the event until PostHog has started.
 */
const loadTiming = { requested: false };

interface PageSeen {
    exited: boolean;
    firstHiddenAt?: number;
    hasBeenVisible: boolean;
}

const startReporter = (reportLoadTiming: (seen: PageSeen) => void, seen: PageSeen): void => {
    try {
        reportLoadTiming(seen);
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- the only trace of why this page sends no load timing
        console.warn("[PostHog] Load timing did not start:", error);
    }
};

const startLoadTiming = (): void => {
    if (loadTiming.requested) {
        return;
    }

    loadTiming.requested = true;

    // What happens while the chunk loads: a page left is still reported, if the document lives long enough for it to
    // arrive, and one shown and then hidden is not taken for a background tab (Safari and Firefox keep no record of it).
    const visibleAtMount = document.visibilityState === "visible";
    const seen: PageSeen = { exited: false, firstHiddenAt: visibleAtMount ? undefined : 0, hasBeenVisible: visibleAtMount };
    const onExit = (): void => {
        seen.exited = true;
    };
    const onVisibility = (): void => {
        if (document.visibilityState === "visible") {
            seen.hasBeenVisible = true;
        } else {
            seen.firstHiddenAt ??= performance.now();
        }
    };
    const stopWatching = (): void => {
        globalThis.removeEventListener("pagehide", onExit);
        document.removeEventListener("visibilitychange", onVisibility);
    };

    globalThis.addEventListener("pagehide", onExit);
    document.addEventListener("visibilitychange", onVisibility);

    void import("@/lib/analytics/load-timing/report-load-timing")
        .then(({ reportLoadTiming }) => {
            stopWatching();
            startReporter(reportLoadTiming, seen);

            return undefined;
        })
        // Only the import can reject here: `startReporter` handles the reporter's own failure. A chunk that fails to load
        // (offline, a deploy in between) only costs this page's timings.
        .catch(stopWatching);
};

/** PostHog's `loaded` callback: applies the consent state that arrived before `posthog.init` finished. */
export const onPostHogLoaded = (ph: PostHogInterface): void => {
    if (import.meta.env.DEV) {
        // In development, opt in for debugging
        ph.opt_in_capturing();
        ph.debug();
    }

    const measurement = getMeasurementConsent();

    if (measurement !== undefined) {
        applyMeasurementConsent(ph, measurement);
    }
};

/** How long a failed analytics start waits before its one retry while the window is online. */
export const START_RETRY_DELAY_MS = 5000;

const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    // Provided once initialised; until then (and while its chunk cannot load) the app runs without analytics.
    const [client, setClient] = useState<PostHog | undefined>(undefined);

    // The landing page view is recorded after commit (a render React abandons claims nothing), in a layout effect: every
    // layout effect runs before any passive one, so it still comes before what a descendant's mount effect queues.
    useLayoutEffect(() => {
        recordLandingPageview();
    }, []);

    useEffect(() => {
        if (import.meta.env.DEV || !globalThis || !import.meta.env.VITE_POSTHOG_API_KEY || !import.meta.env.VITE_POSTHOG_HOST) {
            discardPendingCaptures();

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

        setBootstrapFlags(flagData);
        startLoadTiming();

        let isCancelled = false;

        setIdentityExpected(true);

        // Initialize PostHog with cookieless mode for GDPR compliance
        // PostHog will operate in cookieless mode until consent is granted
        const start = async (): Promise<void> => {
            const posthog = await loadPostHog();
            // A remount (or React's second effect run) finds the singleton already initialised.
            const isFirstInit = !posthog.__loaded;

            if (isFirstInit) {
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
            }

            // Flags are read from the client as soon as `init` ran; captures wait for `startPostHog`.
            // An unmount cancels only the provided client, not the startup: the global error boundary unmounts this
            // provider when it shows its fallback, and the crash it caught is queued for PostHog.
            if (!isCancelled) {
                setClient(posthog);
            }

            // Reset after a sign-out, then the session's identity, then the queued captures and the first launch
            // report; see `startPostHog`. Runs once per page.
            startPostHog(posthog, reportFirstNativeLaunch);
        };

        // A start that failed (the chunk's retries exhausted, or `init` threw) is tried once more after
        // `START_RETRY_DELAY_MS` when the window is online, and again whenever it comes back online.
        let backoffRetriesLeft = 1;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let isWaitingForOnline = false;

        const attempt = (): void => {
            // Back online after the start failed for good: the flags may come after all, so what reads them waits again.
            if (isWaitingForOnline) {
                isWaitingForOnline = false;
                markPostHogRetrying();
            }

            start().catch((error: unknown) => {
                // eslint-disable-next-line no-console -- the only trace of why analytics did not start
                console.warn("[PostHog] Analytics did not start:", error);

                // An unmounted provider still retries: the global boundary unmounts it when it shows its fallback, and
                // the crash it caught waits in the queue for this start. Retries end once PostHog starts.
                if (globalThis.navigator.onLine && backoffRetriesLeft > 0) {
                    backoffRetriesLeft -= 1;
                    retryTimer = setTimeout(attempt, START_RETRY_DELAY_MS);

                    return;
                }

                // Nothing waits for flags that may never come; a start once back online still provides them.
                markPostHogUnavailable();
                isWaitingForOnline = true;
                globalThis.addEventListener("online", attempt, { once: true });
            });
        };

        attempt();

        return () => {
            isCancelled = true;
            // The session that would publish the identity unmounts with this tree.
            setIdentityExpected(false);

            // Started, or never going to (no retry left): nothing queued waits on this provider's retries any more.
            if (getStartedPostHog()) {
                clearTimeout(retryTimer);
                globalThis.removeEventListener("online", attempt);
            }
        };
    }, []);

    return <PostHogClientContext value={client}>{children}</PostHogClientContext>;
};

export default AnalyticsProvider;
