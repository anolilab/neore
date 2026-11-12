/**
 * PostHog, off the first load. `posthog-js` is ~115 KiB gzip and only ever initialised in an effect after mount
 * (`providers/analytics-provider.tsx`), so it is fetched there with a dynamic import rather than shipped with every
 * page. Until it has loaded every reader sees `undefined`, which is what an uninitialised client answered anyway:
 * no flags, nothing captured.
 */
import type { PostHog } from "posthog-js";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { retryChunk } from "@/lib/native/shell-chunk";

const chunk: { loaded?: PostHog; loading?: Promise<PostHog> } = {};

/** The PostHog singleton once its chunk has loaded, else `undefined`. For code outside React or outside the provider. */
export const getPostHog = (): PostHog | undefined => chunk.loaded;

const importPostHog = async (): Promise<PostHog> => {
    try {
        const { posthog } = await retryChunk(async () => await import("posthog-js"));

        chunk.loaded = posthog;

        return posthog;
    } catch (error) {
        // Not cached: a later call tries again.
        chunk.loading = undefined;

        throw error;
    }
};

/** Fetches `posthog-js` once; a failed load is retried, then rejects. */
export const loadPostHog = async (): Promise<PostHog> => {
    chunk.loading ??= importPostHog();

    return await chunk.loading;
};

/** The initialised client, provided by `AnalyticsProvider` (and a fake one in Storybook). */
export const PostHogClientContext = createContext<PostHog | undefined>(undefined);

/** The PostHog client, or `undefined` until it has loaded and been initialised. */
export const usePostHog = (): PostHog | undefined => useContext(PostHogClientContext);

const noSubscription = (): (() => void) => () => {};
const notLoaded = (): undefined => undefined;

/** Whether `flag` is on; `undefined` while PostHog or its flags have not loaded. Follows later flag reloads. */
export const useFeatureFlagEnabled = (flag: string): boolean | undefined => {
    const posthog = usePostHog();
    const subscribe = useCallback((onChange: () => void) => (posthog ? posthog.onFeatureFlags(onChange) : noSubscription()), [posthog]);
    const read = useCallback(() => posthog?.isFeatureEnabled(flag), [posthog, flag]);

    return useSyncExternalStore(subscribe, read, notLoaded);
};
