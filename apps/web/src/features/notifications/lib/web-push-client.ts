/**
 * The browser half of Web Push: permission and the `PushManager` subscription
 * (`@lunora/notify/web`), shaped for `notifications_push.subscribePush`. The
 * handlers that SHOW a push live in `public/push-sw.js`, which the generated
 * service worker imports.
 *
 * There is no service worker in dev (`sw-update-prompt.tsx` registers it only in
 * a production build), so push is unavailable there and the settings card says so.
 */
import { subscribeToPush } from "@lunora/notify/web";

export type PushSupport = "denied" | "no-service-worker" | "supported" | "unsupported";

export const getPushSupport = (): PushSupport => {
    if (typeof window === "undefined" || !("Notification" in globalThis) || !("PushManager" in globalThis) || !("serviceWorker" in navigator)) {
        return "unsupported";
    }

    if (Notification.permission === "denied") {
        return "denied";
    }

    return "supported";
};

/** The active registration, or `undefined` when no service worker controls this page (dev, first load). */
const getRegistration = async (): Promise<ServiceWorkerRegistration | undefined> => {
    const registration = await navigator.serviceWorker.getRegistration();

    return registration?.active ? registration : undefined;
};

export const getCurrentPushSubscription = async (): Promise<PushSubscription | null> => {
    if (getPushSupport() === "unsupported") {
        return null;
    }

    const registration = await getRegistration();

    return registration ? await registration.pushManager.getSubscription() : null;
};

export interface PushSubscriptionPayload {
    endpoint: string;
    keys: { auth: string; p256dh: string };
    /** The subscription a VAPID key rotation replaced; the server drops its row. */
    replacedEndpoint?: string;
    userAgent?: string;
}

/**
 * Asks for permission (a user gesture must be on the stack) and subscribes this
 * browser through `@lunora/notify/web`. Returns the payload to store, or the
 * reason it could not.
 */
export const subscribeBrowser = async (publicKey: string): Promise<{ payload: PushSubscriptionPayload } | { reason: Exclude<PushSupport, "supported"> }> => {
    const support = getPushSupport();

    if (support !== "supported") {
        return { reason: support };
    }

    // Without an active worker (dev) `subscribeToPush` rejects with a bare Error, or
    // waits up to 30s for one still installing; this answers the card's reason now.
    if (!(await getRegistration())) {
        return { reason: "no-service-worker" };
    }

    let result: Awaited<ReturnType<typeof subscribeToPush>>;

    try {
        result = await subscribeToPush({ vapidPublicKey: publicKey });
    } catch (error) {
        if (Notification.permission !== "granted") {
            return { reason: "denied" };
        }

        throw error;
    }

    const { replacedEndpoint, subscription } = result;

    return {
        payload: {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            userAgent: navigator.userAgent.slice(0, 200),
            ...(replacedEndpoint !== undefined && { replacedEndpoint }),
        },
    };
};

/** Unsubscribes this browser; returns the endpoint that was dropped, if any. */
export const unsubscribeBrowser = async (): Promise<string | undefined> => {
    const subscription = await getCurrentPushSubscription();

    if (!subscription) {
        return undefined;
    }

    const { endpoint } = subscription;

    await subscription.unsubscribe();

    return endpoint;
};

/** How long signing out waits for the push release before leaving anyway. */
export const RELEASE_PUSH_TIMEOUT_MS = 3000;

/**
 * Drops this browser's push subscription before its session ends: on the
 * server (while the session still authenticates the call) and in the browser.
 * Without it, the next person to sign in on this browser kept receiving the
 * previous account's notifications. Never throws and never holds a sign-out
 * past `timeoutMs` — the session ends either way.
 */
export const releaseBrowserPush = async (dropOnServer: (endpoint: string) => Promise<unknown>, timeoutMs = RELEASE_PUSH_TIMEOUT_MS): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const subscription = await getCurrentPushSubscription();

        if (!subscription) {
            return;
        }

        await Promise.race([
            Promise.allSettled([dropOnServer(subscription.endpoint), subscription.unsubscribe()]),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } catch {
        // No service worker, no permission, a failed lookup: nothing to release.
    } finally {
        clearTimeout(timer);
    }
};
