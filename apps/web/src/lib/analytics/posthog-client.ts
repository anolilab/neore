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
        const { posthog } = await retryChunk(async () => await import("./posthog-js"));

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

type ExceptionProperties = Parameters<PostHog["captureException"]>[1];

/** How many exceptions caught before PostHog initialised are kept for it; the oldest go first. */
export const MAX_PENDING_EXCEPTIONS = 20;

const pendingExceptions: { error: unknown; properties: ExceptionProperties }[] = [];
const queueState: { closed: boolean } = { closed: false };

/**
 * Reports a caught exception. Before PostHog has initialised (its chunk loads after mount, which can take seconds) the
 * exception is queued, up to `MAX_PENDING_EXCEPTIONS`, and `AnalyticsProvider` sends the queue once `init` and
 * consent have been applied (`flushPendingExceptions`). An opted-out user's are never sent.
 */
export const captureException = (error: unknown, properties?: ExceptionProperties): void => {
    const posthog = chunk.loaded;

    if (posthog?.__loaded) {
        if (!posthog.has_opted_out_capturing()) {
            posthog.captureException(error, properties);
        }

        return;
    }

    if (queueState.closed) {
        return;
    }

    pendingExceptions.push({ error, properties });

    if (pendingExceptions.length > MAX_PENDING_EXCEPTIONS) {
        pendingExceptions.shift();
    }
};

/** Sends what `captureException` queued before `posthog` initialised, unless the user opted out; then queues nothing more. */
export const flushPendingExceptions = (posthog: PostHog): void => {
    const pending = [...pendingExceptions];

    pendingExceptions.length = 0;
    queueState.closed = true;

    if (posthog.has_opted_out_capturing()) {
        return;
    }

    for (const { error, properties } of pending) {
        posthog.captureException(error, properties);
    }
};

/** Analytics will not load in this session (development, or no PostHog key): drop the queue and stop queueing. */
export const discardPendingExceptions = (): void => {
    pendingExceptions.length = 0;
    queueState.closed = true;
};

const resetState: { pending: boolean } = { pending: false };

const clearStorageKeys = (storage: Storage, prefix: string): void => {
    for (const key of Object.keys(storage)) {
        if (key.startsWith(prefix)) {
            storage.removeItem(key);
        }
    }
};

/**
 * Forget the PostHog identity stored for `token` without loading `posthog-js`: a sign-out while its chunk is still
 * downloading reloads before PostHog could `reset()`, and the next page would otherwise boot (and be bootstrapped by
 * the server, which reads the cookie) as the account that left. Removes what posthog-js persists under
 * `ph_<token>_…` (`parseName` in its `posthog-persistence`): the `ph_<token>_posthog` cookie on this host and every
 * parent domain it may have been set on, and the localStorage and sessionStorage entries. The client is also reset
 * once it initialises, for a page that did not reload.
 */
export const forgetPostHogIdentity = (token: string): void => {
    resetState.pending = true;

    const prefix = `ph_${token.replaceAll("+", "PL").replaceAll("/", "SL").replaceAll("=", "EQ")}_`;

    try {
        clearStorageKeys(globalThis.localStorage, prefix);
        clearStorageKeys(globalThis.sessionStorage, prefix);
    } catch {
        // Storage blocked: nothing was persisted there either.
    }

    if (!globalThis.document) {
        return;
    }

    const cookie = `${prefix}posthog=; path=/; max-age=0`;
    const labels = globalThis.location.hostname.split(".");

    // Synchronous on purpose: the sign-out reload follows at once, and the async Cookie Store API could lose that race.
    // eslint-disable-next-line unicorn/no-document-cookie -- see above; posthog-js writes this cookie the same way
    document.cookie = cookie;

    for (let index = 0; index < labels.length - 1; index += 1) {
        // eslint-disable-next-line unicorn/no-document-cookie -- see above
        document.cookie = `${cookie}; domain=.${labels.slice(index).join(".")}`;
    }
};

/** Whether a sign-out asked for a reset before PostHog had initialised; answers `true` once. */
export const takePendingPostHogReset = (): boolean => {
    const { pending } = resetState;

    resetState.pending = false;

    return pending;
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
