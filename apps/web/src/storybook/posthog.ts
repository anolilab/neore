import type { PostHog } from "posthog-js";

/**
 * A stand-in PostHog client for `PostHogProvider`: `isFeatureEnabled` and `getFeatureFlag`
 * answer from `flags` (a story's `parameters.featureFlags`), and every other method is a
 * no-op, so `capture`, `identify` and friends do nothing and send nothing.
 */
export const fakePostHog = (flags: ReadonlyArray<string>): PostHog => {
    const known: Partial<Record<keyof PostHog, unknown>> = {
        getFeatureFlag: (flag: string) => flags.includes(flag),
        isFeatureEnabled: (flag: string) => flags.includes(flag),
        onFeatureFlags: (callback: () => void) => {
            callback();

            return () => {};
        },
    };

    const noop = () => undefined;

    return new Proxy(known, {
        get: (target, property) => target[property as keyof PostHog] ?? noop,
    }) as PostHog;
};
