/**
 * The Android notification channel phone pushes show on, and its name in the phone's language. Kept apart from the
 * app's push wiring so the background task can use them without loading that wiring.
 */
import { languageTag } from "./push-registration";

/** The Android channel phone pushes show on: Expo sends to `default` when a message names none. */
export const ANDROID_CHANNEL_ID = "default";

const LOCALE_SEPARATOR = /[-_]/u;

const CHANNEL_NAMES: Readonly<Record<string, string>> = {
    de: "Benachrichtigungen",
    en: "Notifications",
    es: "Notificaciones",
    fr: "Notifications",
    it: "Notifiche",
    ja: "通知",
    pl: "Powiadomienia",
    pt: "Notificações",
    zh: "通知",
};

/** The phone's language (a BCP 47 tag), sent with the token so the server words the generic alert in it. */
export const deviceLocale = (): string | undefined => {
    try {
        return languageTag(new Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {
        return undefined;
    }
};

/** The language part of a locale (`de` for `de-AT`), or English without one. */
export const languageBase = (locale: string | undefined): string => locale?.toLowerCase().split(LOCALE_SEPARATOR, 1)[0] ?? "en";

/** The Android notification channel's name, as the system settings show it, in the phone's language. */
export const channelName = (locale: string | undefined): string => {
    const base = languageBase(locale);

    return Object.hasOwn(CHANNEL_NAMES, base) ? (CHANNEL_NAMES[base] as string) : (CHANNEL_NAMES.en as string);
};
