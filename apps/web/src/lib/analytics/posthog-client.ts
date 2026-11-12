/**
 * PostHog, off the first load. `posthog-js` is ~115 KiB gzip and only ever initialised in an effect after mount
 * (`providers/analytics-provider.tsx`), so it is fetched there with a dynamic import rather than shipped with every
 * page. Until it has loaded every reader sees `undefined`, which is what an uninitialised client answered anyway:
 * no flags, nothing captured.
 */
import type { PostHog, Properties } from "posthog-js";
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

/** How many events tracked before PostHog initialised are kept for it; the oldest go first. */
export const MAX_PENDING_EVENTS = 50;

/**
 * Where events tracked before PostHog initialised wait. sessionStorage, not memory: a sign-in that tracks and then
 * loads the next page at once (the desktop shell's) would otherwise lose its event with the page.
 */
export const PENDING_EVENTS_KEY = "neore:posthog-pending-events";

interface PendingEvent {
    event: string;
    properties: Properties;
    /** When it was tracked (ISO 8601), sent as the event's time. */
    timestamp: string;
}

const pendingExceptions: { error: unknown; properties: ExceptionProperties }[] = [];
const queueState: { closed: boolean; events?: PendingEvent[] } = { closed: false };

const readStoredEvents = (): PendingEvent[] => {
    try {
        const parsed: unknown = JSON.parse(globalThis.sessionStorage.getItem(PENDING_EVENTS_KEY) ?? "[]");

        return Array.isArray(parsed) ? (parsed as PendingEvent[]) : [];
    } catch {
        return [];
    }
};

const storeEvents = (events: PendingEvent[]): void => {
    try {
        if (events.length === 0) {
            globalThis.sessionStorage.removeItem(PENDING_EVENTS_KEY);
        } else {
            globalThis.sessionStorage.setItem(PENDING_EVENTS_KEY, JSON.stringify(events));
        }
    } catch {
        // Storage blocked or full: the events still wait in memory for this page.
    }
};

/** The queued events, the ones an earlier page of this tab left included. */
const pendingEvents = (): PendingEvent[] => {
    queueState.events ??= readStoredEvents();

    return queueState.events;
};

const dropPendingEvents = (): void => {
    queueState.events = [];
    storeEvents([]);
};

// The measurement consent `PostHogConsentSync` read from c15t; `undefined` until its first effect has run.
const consentState: { measurement?: boolean } = {};

/** The measurement consent last applied, or `undefined` before the consent state has been read. */
export const getMeasurementConsent = (): boolean | undefined => consentState.measurement;

/** Records the measurement consent; a refusal also drops what was queued, so a later grant cannot send it. */
export const setMeasurementConsent = (granted: boolean): void => {
    consentState.measurement = granted;

    if (!granted) {
        pendingExceptions.length = 0;
        dropPendingEvents();
    }
};

/**
 * Reports a caught exception. Before PostHog has initialised (its chunk loads after mount, which can take seconds) the
 * exception is queued, up to `MAX_PENDING_EXCEPTIONS`, and `AnalyticsProvider` sends the queue once `init` and
 * consent have been applied (`flushPendingCaptures`). Nothing is queued while measurement consent is refused, and an
 * opted-out user's are never sent.
 */
export const captureException = (error: unknown, properties?: ExceptionProperties): void => {
    const posthog = chunk.loaded;

    if (posthog?.__loaded) {
        if (!posthog.has_opted_out_capturing()) {
            posthog.captureException(error, properties);
        }

        return;
    }

    if (queueState.closed || consentState.measurement === false) {
        return;
    }

    pendingExceptions.push({ error, properties });

    if (pendingExceptions.length > MAX_PENDING_EXCEPTIONS) {
        pendingExceptions.shift();
    }
};

/**
 * Keeps an event tracked before PostHog initialised, up to `MAX_PENDING_EVENTS`, under the same rules as
 * `captureException`'s queue; `flushPendingCaptures` sends it with the time it was tracked. It outlives a page load in
 * this tab (`PENDING_EVENTS_KEY`).
 */
export const queueEvent = (event: string, properties: Properties): void => {
    if (queueState.closed || consentState.measurement === false) {
        return;
    }

    const events = pendingEvents();

    events.push({ event, properties, timestamp: new Date().toISOString() });

    if (events.length > MAX_PENDING_EVENTS) {
        events.shift();
    }

    storeEvents(events);
};

/**
 * Sends what was queued before `posthog` initialised, events first and then exceptions, unless the user opted out;
 * then queues nothing more. A capture that throws is logged and skipped, so the rest are still sent.
 */
export const flushPendingCaptures = (posthog: PostHog): void => {
    const events = [...pendingEvents()];
    const exceptions = [...pendingExceptions];

    dropPendingEvents();
    pendingExceptions.length = 0;
    queueState.closed = true;

    if (posthog.has_opted_out_capturing()) {
        return;
    }

    for (const { event, properties, timestamp } of events) {
        try {
            posthog.capture(event, properties, { timestamp: new Date(timestamp) });
        } catch (captureError) {
            // eslint-disable-next-line no-console -- the only trace of an event that never left
            console.warn("[PostHog] Could not send a queued event:", captureError);
        }
    }

    for (const { error, properties } of exceptions) {
        try {
            posthog.captureException(error, properties);
        } catch (reportError) {
            // eslint-disable-next-line no-console -- the only trace of a report that never left
            console.warn("[PostHog] Could not report a queued error:", reportError);
        }
    }
};

/** Analytics will not load in this session (development, or no PostHog key): drop the queues and stop queueing. */
export const discardPendingCaptures = (): void => {
    pendingExceptions.length = 0;
    dropPendingEvents();
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
 * once it initialises, for a page that did not reload. Events still queued for PostHog are dropped with it.
 */
export const forgetPostHogIdentity = (token: string): void => {
    resetState.pending = true;
    // Tracked as the account that left: sent after the reset they would count for whoever this browser is next.
    dropPendingEvents();

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
