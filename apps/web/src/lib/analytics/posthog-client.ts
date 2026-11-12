/**
 * PostHog, off the first load. `posthog-js` is ~115 KiB gzip and only ever initialised in an effect after mount
 * (`providers/analytics-provider.tsx`), so it is fetched there with a dynamic import rather than shipped with every
 * page. Until it has loaded every reader sees `undefined`, which is what an uninitialised client answered anyway:
 * no flags, nothing captured.
 */
import type { PostHog, Properties } from "posthog-js";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { redactPromptFromProperties } from "@/lib/analytics/redact-prompt";
import { retryChunk } from "@/lib/native/shell-chunk";

const chunk: { loaded?: PostHog; loading?: Promise<PostHog> } = {};

/** The PostHog singleton once its chunk has loaded, else `undefined`. For code outside React or outside the provider. */
export const getPostHog = (): PostHog | undefined => chunk.loaded;

const startup: { client?: PostHog; isStarted: boolean; onStarted?: () => void } = { isStarted: false };

/** The client once `startPostHog` has finished, else `undefined`: until then, captures queue. */
export const getStartedPostHog = (): PostHog | undefined => (startup.isStarted ? startup.client : undefined);

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
    /** With the page it was tracked on (`pageProperties`). */
    properties?: Properties;
    /** When it was tracked (ISO 8601), sent as the event's time. */
    timestamp: string;
    /** Who tracked it: a user's id, `null` signed out or a guest, absent while the session had not answered yet. */
    userId?: string | null;
}

const pendingExceptions: { error: unknown; properties: ExceptionProperties }[] = [];
const queueState: { closed: boolean; events?: PendingEvent[] } = { closed: false };

/**
 * The `$pageview` of the page this load landed on (`recordLandingPageview`). In memory only: unlike the queued events it
 * is also sent cookieless after a refusal, as PostHog's own initial page view was, so it is never stored.
 */
const landingState: { isRecorded: boolean; pageview?: PendingEvent } = { isRecorded: false };

const isPlainRecord = (value: unknown): value is Partial<Record<keyof PendingEvent, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a stored entry has the shape `queueEvent` wrote: any script of the origin can write to sessionStorage. */
const isPendingEvent = (value: unknown): value is PendingEvent => {
    if (!isPlainRecord(value)) {
        return false;
    }

    const { event, properties, timestamp, userId } = value;

    return (
        typeof event === "string" &&
        (properties === undefined || isPlainRecord(properties)) &&
        typeof timestamp === "string" &&
        !Number.isNaN(Date.parse(timestamp)) &&
        (userId === undefined || userId === null || typeof userId === "string")
    );
};

const readStoredEvents = (): PendingEvent[] => {
    try {
        const parsed: unknown = JSON.parse(globalThis.sessionStorage.getItem(PENDING_EVENTS_KEY) ?? "[]");

        return Array.isArray(parsed) ? parsed.filter((entry: unknown) => isPendingEvent(entry)) : [];
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
 * Reports a caught exception. Before PostHog has started (its chunk loads after mount, which can take seconds; see
 * `startPostHog`) the exception is queued, up to `MAX_PENDING_EXCEPTIONS`, and sent once `init`, consent and the
 * session's identity have been applied (`flushPendingCaptures`). Nothing is queued while measurement consent is refused, and an
 * opted-out user's are never sent.
 */
export const captureException = (error: unknown, properties?: ExceptionProperties): void => {
    const posthog = getStartedPostHog();

    if (posthog) {
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

/** Who the session says is signed in, as `usePostHogIdentity` publishes it. */
export interface AnalyticsIdentity {
    organization?: { id: string; name?: string };
    /** `undefined` when signed out or a guest. */
    user?: { email?: string; id: string; name?: string };
}

const identityState: {
    /** What was last applied to the started client. */
    applied?: { organizationId?: string; userId?: string };
    current?: AnalyticsIdentity;

    /**
     * The user a sign-out ended. The session can still publish them until the page leaves; that is not applied, so
     * PostHog does not identify them again after the reset.
     */
    departedUserId?: string;
    /** The session cannot answer any more (its provider unmounted): start without it rather than never. */
    isAbandoned: boolean;
} = { isAbandoned: false };

/** The page an event is tracked on, as posthog-js would name it then, so a later flush does not name the page it runs on. */
const pageProperties = (): Properties => {
    const { document, location } = globalThis;

    if (!location) {
        return {};
    }

    return {
        // Without the fragment, as `disable_capture_url_hashes` has PostHog do. Callers redact a prompt parameter before
        // keeping it (`redactPromptFromProperties`); `before_send` is the backstop.
        $current_url: `${location.origin}${location.pathname}${location.search}`,
        $host: location.host,
        $pathname: location.pathname,
        $referrer: document?.referrer || "$direct",
    };
};

/**
 * Keeps an event tracked before PostHog started, up to `MAX_PENDING_EVENTS`, under the same rules as
 * `captureException`'s queue; `flushPendingCaptures` sends it with the time it was tracked. It outlives a page load in
 * this tab (`PENDING_EVENTS_KEY`), so a prompt link's text and every fragment are redacted before it is stored.
 */
export const queueEvent = (event: string, properties: Properties): void => {
    if (queueState.closed || consentState.measurement === false) {
        return;
    }

    const events = pendingEvents();

    const { current } = identityState;

    events.push({
        event,
        properties: redactPromptFromProperties({ ...pageProperties(), ...properties }),
        timestamp: new Date().toISOString(),
        userId: current ? (current.user?.id ?? null) : undefined,
    });

    if (events.length > MAX_PENDING_EVENTS) {
        events.shift();
    }

    storeEvents(events);
};

/**
 * Records the page this load landed on, at mount, before the `posthog-js` chunk loads: PostHog's automatic initial page
 * view (`capture_pageview`) would name wherever the visitor is once `init` runs, which can be seconds and an in-app
 * navigation later. `flushPendingCaptures` sends it as the `$pageview`, with the time it was recorded, in order with the
 * queued events. Once per page.
 */
export const recordLandingPageview = (): void => {
    if (landingState.isRecorded || queueState.closed) {
        return;
    }

    landingState.isRecorded = true;
    landingState.pageview = {
        event: "$pageview",
        properties: redactPromptFromProperties(pageProperties()),
        timestamp: new Date().toISOString(),
    };
};

const capturePending = (posthog: PostHog, { event, properties, timestamp }: PendingEvent): void => {
    try {
        posthog.capture(event, properties, { timestamp: new Date(timestamp) });
    } catch (captureError) {
        // eslint-disable-next-line no-console -- the only trace of an event that never left
        console.warn("[PostHog] Could not send a queued event:", captureError);
    }
};

/**
 * Sends what was queued before `posthog` initialised, events first and then exceptions, unless the user opted out;
 * then queues nothing more. A capture that throws is logged and skipped, so the rest are still sent. An event a
 * signed-in user tracked is sent only under that user: one another account (or a sign-out) has replaced since is
 * dropped. One tracked signed out or before the session answered goes to whoever is identified, as PostHog's own
 * anonymous events do. The landing page view (`recordLandingPageview`) goes in at the time it was recorded, whenever
 * PostHog captures at all: also cookieless after a refusal, as its own initial page view did.
 */
export const flushPendingCaptures = (posthog: PostHog): void => {
    const events = [...pendingEvents()];
    const exceptions = [...pendingExceptions];
    const landing = landingState.pageview;

    dropPendingEvents();
    pendingExceptions.length = 0;
    landingState.pageview = undefined;
    queueState.closed = true;

    const isOptedOut = posthog.has_opted_out_capturing();
    const appliedUserId = identityState.applied?.userId;
    const sendable = isOptedOut ? [] : events.filter(({ userId }) => typeof userId !== "string" || userId === appliedUserId);

    if (landing && posthog.is_capturing()) {
        const later = sendable.findIndex(({ timestamp }) => Date.parse(timestamp) > Date.parse(landing.timestamp));

        sendable.splice(later === -1 ? sendable.length : later, 0, landing);
    }

    for (const event of sendable) {
        capturePending(posthog, event);
    }

    if (isOptedOut) {
        return;
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

/**
 * Analytics will not start on this page: development or no PostHog key (`discardPendingCaptures`), or its chunk could
 * not load after the retries. Flags then never arrive, so nothing waits for them (`useFeatureFlagsKnown`).
 */
const availability = { isUnavailable: false, listeners: new Set<() => void>() };

/** Records that PostHog will not start on this page (the chunk failed for good), so nothing waits for its flags. */
export const markPostHogUnavailable = (): void => {
    if (availability.isUnavailable) {
        return;
    }

    availability.isUnavailable = true;

    for (const listener of availability.listeners) {
        listener();
    }
};

/** Analytics will not load in this session (development, or no PostHog key): drop the queues and stop queueing. */
export const discardPendingCaptures = (): void => {
    pendingExceptions.length = 0;
    dropPendingEvents();
    landingState.pageview = undefined;
    queueState.closed = true;
    markPostHogUnavailable();
};

/**
 * A sign-out ended a session that may still navigate as it was: drop what it queued, without closing the queue. The
 * sign-out error path, which leaves for the sign-in page while the session may still be active, uses this; its events
 * must not reach whoever signs in there.
 */
export const dropPendingCaptures = (): void => {
    pendingExceptions.length = 0;
    dropPendingEvents();
    landingState.pageview = undefined;
};

/** The session's user left: the identity applied or waiting is forgotten, and that user is not applied again. */
const departIdentity = (): void => {
    identityState.departedUserId = identityState.current?.user?.id ?? identityState.applied?.userId;
    identityState.current = undefined;
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
 * when it starts, for a page that did not reload, and then waits for a new identity rather than applying the one that
 * left. Events and errors still queued for PostHog are dropped with it.
 */
export const forgetPostHogIdentity = (token: string): void => {
    resetState.pending = true;
    // Startup waits for the next identity the session publishes; the one that left is not applied after the reset.
    departIdentity();
    // Tracked and caught as the account that left: sent after the reset they would count for whoever this browser is
    // next. Later ones still queue, for the signed-out session.
    dropPendingEvents();
    pendingExceptions.length = 0;
    landingState.pageview = undefined;

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

/**
 * Signs the started client out: `reset()`, and the user who left is not identified again if the session publishes
 * them before the page leaves.
 */
export const resetStartedPostHog = (posthog: PostHog): void => {
    posthog.reset();
    departIdentity();
    identityState.applied = {};
};

/** Whether a sign-out asked for a reset before PostHog had started; answers `true` once. */
const takePendingPostHogReset = (): boolean => {
    const { pending } = resetState;

    resetState.pending = false;

    return pending;
};

/** Brings the started client to the published identity: identify, reset on sign-out, the organization group. */
const syncIdentity = (posthog: PostHog): void => {
    const { applied = {}, current = {} } = identityState;
    const userId = current.user?.id;
    const organizationId = current.organization?.id;

    const isReset = Boolean(applied.userId && applied.userId !== userId);

    if (isReset) {
        posthog.reset();
    }

    // After a reset, which clears super properties.
    posthog.register({ is_anonymous: !current.user });

    if (current.user && current.user.id !== applied.userId) {
        posthog.identify(current.user.id, { email: current.user.email, name: current.user.name });
    }

    // A reset dropped the group too, even when the next user is in the same organization.
    if (current.organization && (isReset || organizationId !== applied.organizationId)) {
        posthog.group("organization", current.organization.id, { name: current.organization.name });
    }

    identityState.applied = { organizationId, userId };
};

const finishStartup = (): void => {
    const { client } = startup;

    if (!client || startup.isStarted || (!identityState.current && !identityState.isAbandoned)) {
        return;
    }

    // Read again here: a sign-out may have come while this waited for the session.
    if (takePendingPostHogReset()) {
        client.reset();
    }

    syncIdentity(client);
    startup.isStarted = true;
    flushPendingCaptures(client);
    startup.onStarted?.();
};

/**
 * PostHog's startup, in this order, after `posthog.init` (whose `loaded` callback applied the consent state):
 * 1. a sign-out that came while the chunk loaded resets the bootstrapped identity (`forgetPostHogIdentity` already
 *    dropped what that account had queued);
 * 2. the session's identity and organization group are applied, waiting for `usePostHogIdentity` to publish them if
 *    the session has not answered yet;
 * 3. only then are the queued events and errors sent, and `onStarted` runs (the first native launch report).
 * Until step 3, `trackEvent` and `captureException` keep queueing, so nothing is captured under the wrong identity.
 */
export const startPostHog = (posthog: PostHog, onStarted: () => void): void => {
    if (startup.client) {
        return;
    }

    startup.client = posthog;
    startup.onStarted = onStarted;
    finishStartup();
};

/** Publishes the session's identity; applied at once to a started client, else when PostHog starts. */
export const setAnalyticsIdentity = (identity: AnalyticsIdentity): void => {
    if (identity.user && identity.user.id === identityState.departedUserId) {
        return;
    }

    identityState.departedUserId = undefined;
    identityState.current = identity;

    if (startup.isStarted && startup.client) {
        syncIdentity(startup.client);
    } else {
        finishStartup();
    }
};

/**
 * Whether the session can still publish an identity. The global error boundary's fallback unmounts the app, and the
 * session with it; PostHog then starts without one, so the crash it queued is still sent.
 */
export const setIdentityExpected = (isExpected: boolean): void => {
    identityState.isAbandoned = !isExpected;
    finishStartup();
};

/** The initialised client, provided by `AnalyticsProvider` (and a fake one in Storybook). */
export const PostHogClientContext = createContext<PostHog | undefined>(undefined);

/** The PostHog client, or `undefined` until it has loaded and been initialised. */
export const usePostHog = (): PostHog | undefined => useContext(PostHogClientContext);

const noSubscription = (): (() => void) => () => {};
const notLoaded = (): undefined => undefined;

const subscribeAvailability = (onChange: () => void): (() => void) => {
    availability.listeners.add(onChange);

    return () => {
        availability.listeners.delete(onChange);
    };
};

const readUnavailable = (): boolean => availability.isUnavailable;
const notKnown = (): false => false;

// Clients whose flags have arrived (fetched, persisted, bootstrapped, or failed to load): `onFeatureFlags` answers at
// once for flags it already has.
const clientsWithFlags = new WeakSet<PostHog>();

/**
 * Whether `useFeatureFlagEnabled` and `usePostHog()?.isFeatureEnabled` give their final answer: the client has its
 * flags, or PostHog will not start on this page. Until then a flag reads as off only because it has not arrived.
 */
export const useFeatureFlagsKnown = (): boolean => {
    const posthog = usePostHog();
    const isUnavailable = useSyncExternalStore(subscribeAvailability, readUnavailable, notKnown);
    const subscribe = useCallback(
        (onChange: () => void) =>
            posthog
                ? posthog.onFeatureFlags(() => {
                      clientsWithFlags.add(posthog);
                      onChange();
                  })
                : noSubscription(),
        [posthog],
    );
    const read = useCallback(() => posthog !== undefined && clientsWithFlags.has(posthog), [posthog]);
    const hasFlags = useSyncExternalStore(subscribe, read, notKnown);

    return hasFlags || isUnavailable;
};

/** Whether `flag` is on; `undefined` while PostHog or its flags have not loaded. Follows later flag reloads. */
export const useFeatureFlagEnabled = (flag: string): boolean | undefined => {
    const posthog = usePostHog();
    const subscribe = useCallback((onChange: () => void) => (posthog ? posthog.onFeatureFlags(onChange) : noSubscription()), [posthog]);
    const read = useCallback(() => posthog?.isFeatureEnabled(flag), [posthog, flag]);

    return useSyncExternalStore(subscribe, read, notLoaded);
};
