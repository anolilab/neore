/**
 * The text of a phone push. A push carries only ids (the server never hands a title to Expo, Apple or Google), so the
 * phone asks our backend for the headline and body before it shows the notification, with the session's short-lived JWT.
 *
 * Android does this in its background task (`background-task.ts`); iOS in its Notification Service Extension
 * (`targets/notification-service`), which mirrors {@link fetchPushContent} in Swift. Either way, any failure shows the placeholder.
 */
import type { Fetch, GrantStore } from "../auth/grant";
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

/**
 * The headline and body for one notification; {@link NOT_THIS_ACCOUNT} when it is not the signed-in account's (nothing
 * should show); {@link WITHHELD} when the server will not name its chat; or `undefined` when the phone should keep the
 * placeholder: signed out, offline, too slow, or a failure on our side.
 */
export const fetchPushContent = async (input: {
    fetch: Fetch;
    lunoraUrl: string;
    notificationId: string;
    store: GrantStore;
}): Promise<PushText | typeof NOT_THIS_ACCOUNT | typeof WITHHELD | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_CONTENT_TIMEOUT_MS);

    try {
        // The token exchange counts against the same budget: its own, longer timeout would outlast it.
        const jwt = await fetchAccessToken({
            fetch: async (url, init) => await input.fetch(url, { ...init, signal: controller.signal }),
            lunoraUrl: input.lunoraUrl,
            store: input.store,
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
    fetchContent: (notificationId: string) => Promise<PushText | typeof NOT_THIS_ACCOUNT | typeof WITHHELD | undefined>;
    locale: string | undefined;
    /** Work before showing (the Android channel), done before the last session check so nothing waits between them. */
    prepare?: () => Promise<void>;
    /** Takes back an alert just shown (a sign-out landed between the last check and the post). */
    retract?: (ids: PushIds) => Promise<void>;
    /** The account signed in on this phone right now, or `undefined`. A push for nobody shows nothing. */
    sessionUserId: () => Promise<string | undefined>;
    show: (text: PushText, ids: PushIds) => Promise<void>;
}

/**
 * A notification-style push carries its alert in `notification`, and the system shows that alert itself. Android runs this
 * task for it in the foreground too, so only a data-only push (no `notification`) gets an alert built here.
 */
const isNotificationStyle = (payload: unknown): boolean =>
    typeof payload === "object" && payload !== null && "notification" in payload && Boolean(payload.notification);

/**
 * Android's data-only push, in the background task: read the ids, fetch the text, and show the notification on the
 * device, the placeholder when the fetch fails. The text shows only if the account that fetched it is still the one
 * signed in when it is about to show: a sign-out or account switch while it was on its way gets the placeholder. A
 * notification the server says is not the signed-in account's shows nothing at all. A withheld chat, or one whose account
 * changed meanwhile, keeps the placeholder but loses its thread, so a tap opens the chat list. Resolves whether a
 * notification was shown.
 */
export const showDataOnlyPush = async (payload: unknown, steps: PushTaskSteps): Promise<boolean> => {
    const ids = isNotificationStyle(payload) ? undefined : pushIdsIn(payload);

    if (!ids) {
        return false;
    }

    const fetchedFor = await steps.sessionUserId();

    if (fetchedFor === undefined) {
        return false;
    }

    const fetched = await steps.fetchContent(ids.notificationId);

    // Another account's notification: post nothing, so its ids never land under the account signed in now.
    if (fetched === NOT_THIS_ACCOUNT) {
        return false;
    }

    await steps.prepare?.();

    const isSameSession = await steps.sessionUserId() === fetchedFor;
    const realText = isSameSession && typeof fetched === "object" ? fetched : undefined;
    const text = realText ?? pushPlaceholder(steps.locale);
    const shownIds = fetched === WITHHELD || !isSameSession ? { notificationId: ids.notificationId } : ids;

    await steps.show(text, shownIds);

    // A sign-out can still land between that check and the post: look once more, and take the real text back if so.
    if (realText !== undefined && await steps.sessionUserId() !== fetchedFor) {
        await steps.retract?.(shownIds);
    }

    return true;
};
