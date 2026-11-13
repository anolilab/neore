/**
 * PostHog, off the first load. `posthog-js` is ~115 KiB gzip and only ever initialised in an effect after mount
 * (`providers/analytics-provider.tsx`), so it is fetched there with a dynamic import rather than shipped with every
 * page. Until it has loaded every reader sees `undefined`, which is what an uninitialised client answered anyway:
 * no flags, nothing captured.
 */
import type { PostHog, Properties } from "posthog-js";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { redactPromptFromProperties } from "@/lib/analytics/redact-prompt";
import { retryChunk } from "@/lib/native/shell-chunk";

const chunk: { loaded?: PostHog; loading?: Promise<PostHog> } = {};

/** The PostHog singleton once its chunk has loaded, else `undefined`. For code outside React or outside the provider. */
export const getPostHog = (): PostHog | undefined => chunk.loaded;

const startup: { client?: PostHog; isStarted: boolean; listeners: Set<() => void>; onStarted?: () => void } = {
    isStarted: false,
    listeners: new Set<() => void>(),
};

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

/**
 * How long a queued event waits for PostHog. One older is dropped, from memory and from sessionStorage, and never sent:
 * a tab whose analytics stays blocked or offline does not keep what it tracked (its pages, who was signed in) for its
 * whole life.
 */
export const PENDING_EVENT_MAX_AGE_MS = 60 * 60 * 1000;

interface PendingEvent {
    event: string;
    /** With the page it was tracked on (`pageProperties`). */
    properties?: Properties;
    /** When it was tracked (ISO 8601), sent as the event's time. */
    timestamp: string;
    /** Who tracked it: a user's id, `null` signed out or a guest, absent while the session had not answered yet. */
    userId?: string | null;
}

/** A caught error waiting for PostHog, with who was signed in then, as a queued event carries it (`PendingEvent.userId`). */
const pendingExceptions: { caughtAt: number; error: unknown; properties: ExceptionProperties; userId?: string | null }[] = [];

/** Drops the queued errors past the age limit the queued events keep (`PENDING_EVENT_MAX_AGE_MS`): never sent late. */
const dropExpiredExceptions = (): void => {
    const oldest = Date.now() - PENDING_EVENT_MAX_AGE_MS;
    const fresh = pendingExceptions.filter(({ caughtAt }) => caughtAt >= oldest);

    pendingExceptions.splice(0, pendingExceptions.length, ...fresh);
};
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

// The measurement consent `PostHogConsentSync` read from c15t; `undefined` until its first effect has run.
const consentState: { measurement?: boolean } = {};

/**
 * Writes the queue to sessionStorage, only once measurement consent is granted: before that what is tracked waits in
 * memory alone (`setMeasurementConsent` stores it on a grant, drops it on a refusal). Emptying it always goes through.
 */
const storeEvents = (events: PendingEvent[]): void => {
    try {
        if (events.length === 0) {
            globalThis.sessionStorage.removeItem(PENDING_EVENTS_KEY);
        } else if (consentState.measurement === true) {
            globalThis.sessionStorage.setItem(PENDING_EVENTS_KEY, JSON.stringify(events));
        }
    } catch {
        // Storage blocked or full: the events still wait in memory for this page.
    }
};

/** The queued events, the ones an earlier page of this tab left included; those past the age limit are dropped first. */
const pendingEvents = (): PendingEvent[] => {
    queueState.events ??= readStoredEvents();

    const { events } = queueState;
    const oldest = Date.now() - PENDING_EVENT_MAX_AGE_MS;
    const fresh = events.filter(({ timestamp }) => Date.parse(timestamp) >= oldest);

    if (fresh.length !== events.length) {
        events.splice(0, events.length, ...fresh);
        storeEvents(events);
    }

    return events;
};

const dropPendingEvents = (): void => {
    queueState.events = [];
    storeEvents([]);
};

/** The event a sign-out tracks just before it drops the queue: it survives the drop (`dropForSignOut`). */
const SIGN_OUT_EVENT = "signed_out";

/**
 * A sign-out's drop: what the account that left queued goes, except the sign-out itself, kept as a signed-out event
 * (`userId: null`), so it is sent, after the reset, by whichever page next starts PostHog in this tab.
 */
const dropForSignOut = (): void => {
    const kept = pendingEvents()
        .filter(({ event }) => event === SIGN_OUT_EVENT)
        .map((event: PendingEvent) => {
            return { ...event, userId: null };
        });

    queueState.events = kept;
    storeEvents(kept);
};

/** The measurement consent last applied, or `undefined` before the consent state has been read. */
export const getMeasurementConsent = (): boolean | undefined => consentState.measurement;

/** Records the measurement consent; a refusal also drops what was queued, so a later grant cannot send it. */
export const setMeasurementConsent = (granted: boolean): void => {
    consentState.measurement = granted;

    if (!granted) {
        pendingExceptions.length = 0;
        dropPendingEvents();

        return;
    }

    // Granted: what waited in memory for it is kept across a navigation from now on.
    if (queueState.events !== undefined && !queueState.closed) {
        storeEvents(queueState.events);
    }
};

/** Who the session says is signed in, as `usePostHogIdentity` publishes it. */
export interface AnalyticsIdentity {
    /**
     * The signed-in user's organization has not answered yet. The startup waits for it, so what was queued goes out with
     * its group; a started client takes the user now (events from here on are theirs) and the group once it answers.
     */
    isOrganizationPending?: boolean;
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

/** Who a capture made now is tracked as: a user's id, `null` signed out or a guest, `undefined` before the session answered. */
const caughtUnder = (): string | null | undefined => {
    const { current } = identityState;

    return current ? (current.user?.id ?? null) : undefined;
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

    dropExpiredExceptions();
    pendingExceptions.push({ caughtAt: Date.now(), error, properties, userId: caughtUnder() });

    if (pendingExceptions.length > MAX_PENDING_EXCEPTIONS) {
        pendingExceptions.shift();
    }
};

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

    dropExpiredExceptions();

    const exceptions = [...pendingExceptions];
    const landing = landingState.pageview;

    dropPendingEvents();
    pendingExceptions.length = 0;
    landingState.pageview = undefined;
    queueState.closed = true;

    const isOptedOut = posthog.has_opted_out_capturing();
    const appliedUserId = identityState.applied?.userId;
    const sendable = isOptedOut ? [] : events.filter(({ userId }) => typeof userId !== "string" || userId === appliedUserId);

    const isLandingTheirs = typeof landing?.userId !== "string" || landing.userId === appliedUserId;

    if (landing && isLandingTheirs && posthog.is_capturing()) {
        // Before what this page queued in the same millisecond: the page view opens the page it was recorded on.
        const later = sendable.findIndex(({ timestamp }) => Date.parse(timestamp) >= Date.parse(landing.timestamp));

        sendable.splice(later === -1 ? sendable.length : later, 0, landing);
    }

    for (const event of sendable) {
        capturePending(posthog, event);
    }

    if (isOptedOut) {
        return;
    }

    // As the events: one caught while another account was signed in is not sent as this one.
    for (const { error, properties, userId } of exceptions) {
        if (typeof userId === "string" && userId !== appliedUserId) {
            continue;
        }

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
const availability = {
    /**
     * A start failed (or never runs) on this page. Unlike `isUnavailable`, a retry does not clear it: until a client is
     * provided, flags keep answering from the server-rendered ones instead of going back to pending.
     */
    hasFailed: false,
    isUnavailable: false,
    listeners: new Set<() => void>(),
};

const setUnavailable = (isUnavailable: boolean): void => {
    if (availability.isUnavailable === isUnavailable) {
        return;
    }

    availability.isUnavailable = isUnavailable;
    availability.hasFailed ||= isUnavailable;

    for (const listener of availability.listeners) {
        listener();
    }
};

/** Records that PostHog will not start on this page (the chunk failed for good), so nothing waits for its flags. */
export const markPostHogUnavailable = (): void => {
    setUnavailable(true);
};

/**
 * A start is tried again (the window came back online): its flags may arrive after all, so what reads them waits
 * again until they do or the start fails. Not in a session analytics never loads in (`discardPendingCaptures`).
 */
export const markPostHogRetrying = (): void => {
    if (!queueState.closed) {
        setUnavailable(false);
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
    dropForSignOut();
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
    // next. Later ones still queue, for the signed-out session; so does the sign-out itself, as a signed-out event.
    dropForSignOut();
    pendingExceptions.length = 0;
    landingState.pageview = undefined;

    const prefix = `ph_${token.replaceAll("+", "PL").replaceAll("/", "SL").replaceAll("=", "EQ")}_`;

    try {
        clearStorageKeys(globalThis.localStorage, prefix);
    } catch {
        // Storage blocked: nothing was persisted there either.
    }

    // Apart: one storage blocked must not keep the other's identity (the session's window id) past the sign-out.
    try {
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

/**
 * Whether the client's persisted identity is an identified user other than `userId`: one this page never applied (a
 * session that ended on the server, then another account on a later load). An anonymous visitor's id is not one, so
 * a sign-in still merges it.
 */
const isStoredAnotherUser = (posthog: PostHog, userId: string | undefined): boolean =>
    posthog.get_property("$user_state") === "identified" && posthog.get_distinct_id() !== userId;

/** Brings the started client to the published identity: identify, reset on sign-out, the organization group. */
const syncIdentity = (posthog: PostHog): void => {
    const { applied = {}, current = {} } = identityState;
    const userId = current.user?.id;
    const organizationId = current.organization?.id;

    const isReset = applied.userId === undefined ? isStoredAnotherUser(posthog, userId) : applied.userId !== userId;

    if (isReset) {
        posthog.reset();
    }

    // After a reset, which clears super properties.
    posthog.register({ is_anonymous: !current.user });

    if (current.user && current.user.id !== applied.userId) {
        posthog.identify(current.user.id, { email: current.user.email, name: current.user.name });
    }

    if (current.isOrganizationPending) {
        // The group the client holds stays until the organization answers, unless a reset dropped it with the old user.
        identityState.applied = { organizationId: isReset ? undefined : applied.organizationId, userId };

        return;
    }

    // A reset dropped the group too, even when the next user is in the same organization.
    if (current.organization && (isReset || organizationId !== applied.organizationId)) {
        posthog.group("organization", current.organization.id, { name: current.organization.name });
    }

    identityState.applied = { organizationId, userId };
};

/**
 * How long startup waits for a signed-in user's organization. A read that stalls past it does not hold every capture:
 * PostHog starts with the user alone, and the group is applied once the organization answers.
 */
export const ORGANIZATION_WAIT_MS = 5000;

/** The bounded wait for one user's organization: another user starts a wait of their own. */
const organizationWait: { isOver: boolean; timer?: ReturnType<typeof setTimeout>; userId?: string } = { isOver: false };

/**
 * How long startup waits for the session's first answer once PostHog has loaded. A session read that never settles
 * does not hold every capture: PostHog starts without a user (after a reset, as whose it was is unknown), and the
 * session's identity is applied when it does answer.
 */
export const SESSION_WAIT_MS = 10_000;

const sessionWait: { isOver: boolean; timer?: ReturnType<typeof setTimeout> } = { isOver: false };

/**
 * How long, once started, the flag-gated model list and the code shell wait for PostHog's flags. Flags that never
 * arrive (a failed `/flags` with nothing persisted, flags disabled) stop holding them: what reads them then decides.
 */
export const FLAGS_WAIT_MS = 10_000;

const flagsWait: { isOver: boolean } = { isOver: false };

/**
 * The sign-outs a sign-out's drop kept (`dropForSignOut`), sent before the session's identity is applied: the client is
 * still the signed-out one then (the sign-out cleared what it stored), so the count is kept and never lands on an account
 * that signed in on this page.
 */
const sendKeptSignOuts = (posthog: PostHog): void => {
    const events = pendingEvents();
    const kept = events.filter(({ event, userId }) => event === SIGN_OUT_EVENT && userId === null);

    if (kept.length === 0) {
        return;
    }

    const rest = events.filter((event: PendingEvent) => !kept.includes(event));

    queueState.events = rest;
    storeEvents(rest);

    if (posthog.has_opted_out_capturing()) {
        return;
    }

    for (const event of kept) {
        capturePending(posthog, event);
    }
};

const finishStartup = (): void => {
    const { client } = startup;

    const isIdentityKnown = identityState.current !== undefined && (!identityState.current.isOrganizationPending || organizationWait.isOver);

    if (!client || startup.isStarted || (!isIdentityKnown && !identityState.isAbandoned && !sessionWait.isOver)) {
        return;
    }

    clearTimeout(sessionWait.timer);

    // Read again here: a sign-out may have come while this waited for the session.
    if (takePendingPostHogReset()) {
        client.reset();
    }

    sendKeptSignOuts(client);
    syncIdentity(client);
    startup.isStarted = true;
    // Flags that never arrive stop holding what waits for them, after a bound.
    setTimeout(() => {
        flagsWait.isOver = true;

        for (const listener of startup.listeners) {
            listener();
        }
    }, FLAGS_WAIT_MS);
    flushPendingCaptures(client);
    startup.onStarted?.();

    for (const listener of startup.listeners) {
        listener();
    }
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

    // The session may never answer: bounded, PostHog then starts without a user.
    if (identityState.current === undefined && !identityState.isAbandoned) {
        sessionWait.timer = setTimeout(() => {
            sessionWait.timer = undefined;

            if (identityState.current !== undefined) {
                return;
            }

            sessionWait.isOver = true;
            // Whose identity the client stored is unknown: it is not carried into a start without one.
            resetState.pending = true;
            finishStartup();
        }, SESSION_WAIT_MS);
    }

    finishStartup();
};

/** Starts the bound on a pending organization, once per wait; an answer (or no user to wait for) ends it. */
const waitForOrganization = (identity: AnalyticsIdentity): void => {
    const userId = identity.user?.id;
    const isSameWait = organizationWait.userId === userId && (organizationWait.timer !== undefined || organizationWait.isOver);

    if (identity.isOrganizationPending && !startup.isStarted && isSameWait) {
        return;
    }

    clearTimeout(organizationWait.timer);
    organizationWait.timer = undefined;
    organizationWait.isOver = false;
    organizationWait.userId = undefined;

    if (!identity.isOrganizationPending || startup.isStarted) {
        return;
    }

    organizationWait.userId = userId;

    organizationWait.timer = setTimeout(() => {
        organizationWait.timer = undefined;
        organizationWait.isOver = true;
        finishStartup();
    }, ORGANIZATION_WAIT_MS);
};

/** Publishes the session's identity; applied at once to a started client, else when PostHog starts. */
export const setAnalyticsIdentity = (identity: AnalyticsIdentity): void => {
    if (identity.user && identity.user.id === identityState.departedUserId) {
        return;
    }

    // The session ended or switched accounts before PostHog started: the client may still hold that account's identity
    // from an earlier page, so the startup resets it before anything queued is sent.
    const previousUserId = identityState.current?.user?.id;

    if (!startup.isStarted && previousUserId !== undefined && previousUserId !== identity.user?.id) {
        resetState.pending = true;
    }

    identityState.departedUserId = undefined;
    identityState.current = identity;
    waitForOrganization(identity);

    // The landing page view belongs to the first account the session names: one that switches before PostHog starts
    // does not send it (`flushPendingCaptures` applies the events' rule to it).
    if (landingState.pageview && landingState.pageview.userId === undefined) {
        landingState.pageview.userId = identity.user?.id ?? null;
    }

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

const subscribeStarted = (onChange: () => void): (() => void) => {
    startup.listeners.add(onChange);

    return () => {
        startup.listeners.delete(onChange);
    };
};

/**
 * The client once PostHog has started: the reset after a sign-out, the session's identity and the queued captures are
 * applied. What captures on its own (the onboarding plugin) takes this one, not `usePostHog()`'s, which is provided as
 * soon as `init` ran and still holds the identity it was bootstrapped with.
 */
const readFlagsWaitOver = (): boolean => flagsWait.isOver;

export const useStartedPostHog = (): PostHog | undefined => useSyncExternalStore(subscribeStarted, getStartedPostHog, () => undefined);

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
/** With no client: whether flags answer from the server-rendered ones (a start failed, even while a retry runs). */
const readFallsBack = (): boolean => availability.hasFailed;
const notKnown = (): false => false;

interface FlagStore {
    /** The flags arrived (fetched, persisted, bootstrapped, or failed to load): what the client answers is final. */
    hasFlags: boolean;
    listeners: Set<() => void>;
    loads: number;
}

/**
 * Each client's flags, from the one `onFeatureFlags` listener per client that every flag hook goes through: a hook that
 * subscribes adds a listener to the set, and changes no count (PostHog answers a new `onFeatureFlags` at once when it
 * holds flags already).
 */
const flagStores = new WeakMap<PostHog, FlagStore>();

const flagStoreOf = (posthog: PostHog): FlagStore => {
    const known = flagStores.get(posthog);

    if (known) {
        return known;
    }

    const store: FlagStore = { hasFlags: false, listeners: new Set<() => void>(), loads: 0 };

    flagStores.set(posthog, store);
    posthog.onFeatureFlags(() => {
        store.hasFlags = true;
        store.loads += 1;

        for (const listener of store.listeners) {
            listener();
        }
    });

    return store;
};

const noLoads = (): number => 0;

/** `useSyncExternalStore`'s subscribe for a client's flags, through its one listener; registers it on first use. */
const subscribeFlags =
    (posthog: PostHog | undefined) =>
    (onChange: () => void): (() => void) => {
        if (!posthog) {
            return noSubscription();
        }

        const { listeners } = flagStoreOf(posthog);

        listeners.add(onChange);

        return () => {
            listeners.delete(onChange);
        };
    };

/** Whether a client's flags arrived. Read only: the listener is registered by a subscribe, never by a render. */
const hasFlagsOf = (posthog: PostHog | undefined): boolean => posthog !== undefined && flagStores.get(posthog)?.hasFlags === true;

/**
 * Whether `useFeatureFlagEnabled` and `usePostHog()?.isFeatureEnabled` give their final answer: the client has its
 * flags, or PostHog will not start on this page. Until then a flag reads as off only because it has not arrived.
 */
export const useFeatureFlagsKnown = (): boolean => {
    const posthog = usePostHog();
    const started = useStartedPostHog();
    const isUnavailable = useSyncExternalStore(subscribeAvailability, readUnavailable, notKnown);
    const subscribe = useMemo(() => subscribeFlags(posthog), [posthog]);
    const read = useCallback(() => hasFlagsOf(posthog), [posthog]);
    const hasFlags = useSyncExternalStore(subscribe, read, notKnown);
    // The client this module loads answers for the signed-in account only once it has started (the reset and the
    // session's identity applied): before, its flags are the bootstrapped ones. A client provided otherwise (Storybook's)
    // is never started here, and its flags are final as they come.
    const isOwnClient = posthog !== undefined && posthog === getPostHog();
    // Started, and its flags still have not come within `FLAGS_WAIT_MS`: nothing waits for them any longer.
    const isFlagsWaitOver = useSyncExternalStore(subscribeStarted, readFlagsWaitOver, notKnown);

    return (hasFlags && (!isOwnClient || started === posthog)) || isUnavailable || (isOwnClient && started === posthog && isFlagsWaitOver);
};

/** The flags the server rendered into the page (`posthog-data`), for when PostHog itself never loads. */
const bootstrapState: { flags?: Readonly<Record<string, boolean | string>> } = {};

/** Keeps the server-rendered flags, so a page whose PostHog chunk is blocked or fails still answers them. */
export const setBootstrapFlags = (flags: Readonly<Record<string, boolean | string>> | undefined): void => {
    bootstrapState.flags = flags;
};

/** As PostHog's `isFeatureEnabled` reads a bootstrapped flag: a variant counts as on, an absent flag as off. */
const readBootstrapFlag = (flag: string): boolean => {
    const value = bootstrapState.flags?.[flag];

    return value !== undefined && value !== false;
};

/**
 * Reads flags as `useFeatureFlagEnabled` does, for a list that checks many: the client's answer, or once PostHog will
 * not start on this page, the server-rendered flag (else off); `undefined` while the client may still come. The reader
 * changes when the client or its availability does, so a memo or filter over it follows.
 */
export const useFeatureFlagReader = (): ((flag: string) => boolean | undefined) => {
    const posthog = usePostHog();
    const fallsBack = useSyncExternalStore(subscribeAvailability, readFallsBack, notKnown);
    // Counts the client's flag loads and reloads, so the reader changes with them and a memo over it recomputes.
    const subscribe = useMemo(() => subscribeFlags(posthog), [posthog]);
    // Read only: the listener is registered by `subscribe`, never by a render React may throw away.
    const readLoads = useCallback(() => (posthog ? (flagStores.get(posthog)?.loads ?? 0) : 0), [posthog]);
    const loads = useSyncExternalStore(subscribe, readLoads, noLoads);

    return useCallback(
        (flag: string) => {
            if (posthog) {
                return posthog.isFeatureEnabled(flag);
            }

            return fallsBack ? readBootstrapFlag(flag) : undefined;
        },
        // `loads` is the reader's version: the flags it reads changed.

        [posthog, fallsBack, loads],
    );
};

/**
 * Whether `flag` is on; `undefined` while PostHog or its flags have not loaded. Follows later flag reloads. When PostHog
 * will not start on this page (its chunk failed for good, blocked, no key), the server-rendered flag answers, or `false`:
 * what is gated shows its "not available" state instead of waiting for ever.
 */
export const useFeatureFlagEnabled = (flag: string): boolean | undefined => {
    const posthog = usePostHog();
    const fallsBack = useSyncExternalStore(subscribeAvailability, readFallsBack, notKnown);
    const subscribe = useMemo(() => subscribeFlags(posthog), [posthog]);
    // A client whose flags have not arrived reads every flag as off: that is not an answer yet, so it stays pending.
    const read = useCallback(() => (posthog && hasFlagsOf(posthog) ? posthog.isFeatureEnabled(flag) : undefined), [posthog, flag]);
    const enabled = useSyncExternalStore(subscribe, read, notLoaded);
    const started = useStartedPostHog();
    const isFlagsWaitOver = useSyncExternalStore(subscribeStarted, readFlagsWaitOver, notKnown);

    if (posthog === undefined) {
        return fallsBack ? readBootstrapFlag(flag) : enabled;
    }

    // Started, and its flags did not come within `FLAGS_WAIT_MS`: the server-rendered flag answers (else off), so what
    // is gated shows instead of staying blank. Flags that arrive later still take over.
    if (enabled === undefined && posthog === getPostHog() && started === posthog && isFlagsWaitOver) {
        return readBootstrapFlag(flag);
    }

    return enabled;
};
