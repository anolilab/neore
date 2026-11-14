/**
 * The text of a phone push. A push carries only ids (the server never hands a title to Expo, Apple or Google), so the
 * phone asks our backend for the headline and body before it shows the notification, with the session's short-lived JWT.
 *
 * Android does this in its background task (`background-task.ts`); iOS in its Notification Service Extension
 * (`targets/notification-service`), which mirrors {@link fetchPushContent} in Swift. Either way, any failure shows the placeholder.
 */
import type { NotificationTrigger } from "expo-notifications";

import type { Fetch, GrantStore, StoredGrant } from "../auth/grant";
import { fetchAccessToken } from "../auth/grant";
import { languageBase } from "./push-channel";
import type { PushIds } from "./push-registration";
import { pushIdsIn } from "./push-registration";

/** The Android background task that builds a data-only push's alert (`background-task.ts`). */
export const PHONE_PUSH_TASK = "neore-phone-push";

export interface PushText {
    body: string;
    title: string;
}

/** Well inside the iOS extension's ~30 s and Android's background budget. */
export const PUSH_CONTENT_TIMEOUT_MS = 10_000;

/** The server does not know the notification for the signed-in account: it belongs to someone else, or no longer exists. */
export const NOT_THIS_ACCOUNT = "not-this-account";

/** The server withholds the text (`{ generic: true }`): the chat is locked, unshared or deleted, or its check failed. */
export const WITHHELD = "withheld";

/** A store that reads only `grant`, so the token is minted from the grant the caller read and nothing here writes or clears it. */
const readOnly = (grant: StoredGrant): GrantStore => {
    return {
        clear: async () => undefined,
        get: async () => grant,
        set: async () => undefined,
    };
};

/**
 * The headline and body for one notification, minted from `grant`: {@link NOT_THIS_ACCOUNT} when it is not that account's
 * (nothing should show); {@link WITHHELD} when the server will not name its chat; or `undefined` when the phone should keep
 * the placeholder: a refused session, offline, too slow, or a failure on our side.
 */
export const fetchPushContent = async (input: {
    fetch: Fetch;
    grant: StoredGrant;
    lunoraUrl: string;
    notificationId: string;
}): Promise<PushText | typeof NOT_THIS_ACCOUNT | typeof WITHHELD | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_CONTENT_TIMEOUT_MS);

    try {
        // The token exchange counts against the same budget: its own, longer timeout would outlast it.
        const jwt = await fetchAccessToken({
            fetch: async (url, init) => await input.fetch(url, { ...init, signal: controller.signal }),
            lunoraUrl: input.lunoraUrl,
            store: readOnly(input.grant),
        });

        if (jwt === null) {
            return undefined;
        }

        const response = await input.fetch(`${input.lunoraUrl}/notifications/push-content`, {
            body: JSON.stringify({ notificationId: input.notificationId }),
            credentials: "omit",
            headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        });

        if (!response.ok) {
            await response.body?.cancel();

            // 404: this notification is not the signed-in account's (it switched since the push went out).
            return response.status === 404 ? NOT_THIS_ACCOUNT : undefined;
        }

        const { body, generic, title } = (await response.json()) as { body?: unknown; generic?: unknown; title?: unknown };

        if (generic === true) {
            return WITHHELD;
        }

        return typeof title === "string" && typeof body === "string" ? { body, title } : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
};

const PLACEHOLDER_BODIES: Readonly<Record<string, string>> = {
    de: "Du hast eine neue Benachrichtigung",
    en: "You have a new notification",
    es: "Tienes una notificación nueva",
    fr: "Vous avez une nouvelle notification",
    it: "Hai una nuova notifica",
    ja: "新しい通知があります",
    pl: "Masz nowe powiadomienie",
    pt: "Você tem uma nova notificação",
    zh: "你有一条新通知",
};

/** What shows when the real text cannot be had: the same words the server gives iPhones, in the phone's language. */
export const pushPlaceholder = (locale: string | undefined): PushText => {
    const base = languageBase(locale);

    return {
        body: Object.hasOwn(PLACEHOLDER_BODIES, base) ? (PLACEHOLDER_BODIES[base] as string) : (PLACEHOLDER_BODIES.en as string),
        title: "Neore",
    };
};

export interface PushTaskSteps {
    /** The text for one notification, minted from the grant it is asked with. */
    fetchContent: (grant: StoredGrant, notificationId: string) => Promise<PushText | typeof NOT_THIS_ACCOUNT | typeof WITHHELD | undefined>;
    locale: string | undefined;
    /** Work before showing (the Android channel). A failure is not fatal: the alert is still posted. */
    prepare?: () => Promise<void>;
    /** Takes back an alert just posted, once the account it was for has changed or signed out. */
    retract?: (ids: PushIds) => Promise<void>;
    /** The grant signed in on this phone right now, or `undefined`. A push for nobody shows nothing. */
    session: () => Promise<StoredGrant | undefined>;
    show: (text: PushText, ids: PushIds) => Promise<void>;
}

/**
 * A notification-style push carries its alert in `notification`, and the system shows that alert itself. Android runs this
 * task for it in the foreground too, so only a data-only push (no `notification`) gets an alert built here.
 */
const isNotificationStyle = (payload: unknown): boolean =>
    typeof payload === "object" && payload !== null && "notification" in payload && Boolean(payload.notification);

/**
 * A data-only Android push: its trigger carries a `remoteMessage` with no `notification`. The task posts its alert, so the
 * system shows none for it. An iOS trigger carries a `payload` instead and is never data-only here.
 */
export const isDataOnlyPush = (trigger: NotificationTrigger | null | undefined): boolean => {
    if (!trigger || !("remoteMessage" in trigger)) {
        return false;
    }

    return trigger.remoteMessage !== undefined && !trigger.remoteMessage.notification;
};

/** The ids of a data-only push, or `undefined` for one the system alerts itself. */
export const dataOnlyPushIds = (payload: unknown): PushIds | undefined => {
    if (isNotificationStyle(payload)) {
        return undefined;
    }

    return pushIdsIn(payload);
};

/**
 * Android's data-only push, in the background task: read the ids, fetch the text with the grant read here, and show the
 * notification on the device, the placeholder when the fetch fails. The text shows only if the account that fetched it is
 * still the one signed in when it is about to show. An account that changed or signed out while the alert was posted has
 * it taken back. A notification the server says is not the signed-in account's shows nothing at all. A withheld chat, or one
 * whose account changed meanwhile, keeps the placeholder but loses its thread, so a tap opens the chat list. A phone signed
 * out shows nothing; an error thrown while showing is answered by the caller (`background-task.ts`). Resolves whether a
 * notification was shown.
 */
export const showDataOnlyPush = async (payload: unknown, steps: PushTaskSteps): Promise<boolean> => {
    const ids = dataOnlyPushIds(payload);

    if (!ids) {
        return false;
    }

    const grant = await steps.session();

    if (grant === undefined) {
        return false;
    }

    const fetchedFor = grant.user.id;
    const fetched = await steps.fetchContent(grant, ids.notificationId);

    // Another account's notification: post nothing, so its ids never land under the account signed in now.
    if (fetched === NOT_THIS_ACCOUNT) {
        return false;
    }

    try {
        await steps.prepare?.();
    } catch {
        // The channel normally exists already (the app creates it at start); a failed set-up must not stop the alert.
    }

    const current = await steps.session();
    const isSameSession = current?.user.id === fetchedFor;
    const realText = isSameSession && typeof fetched === "object" ? fetched : undefined;
    const text = realText ?? pushPlaceholder(steps.locale);
    const shownIds = fetched === WITHHELD || !isSameSession ? { notificationId: ids.notificationId } : ids;

    await steps.show(text, shownIds);

    // A sign-out or account switch can land between the check above and the post: the alert is taken back, text or placeholder.
    let isUnchanged = false;

    try {
        const afterPost = await steps.session();

        isUnchanged = afterPost?.user.id === fetchedFor;
    } catch {
        // A read that fails leaves the account unconfirmed, so the alert is taken back.
    }

    if (!isUnchanged) {
        await steps.retract?.(shownIds);
    }

    return true;
};
