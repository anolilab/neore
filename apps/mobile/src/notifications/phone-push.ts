/**
 * The device and server halves of push for `push-registration.ts`: the system's
 * permission and the Expo push token through expo-notifications, and the backend's
 * register and unregister procedures. A push carries only a generic alert and ids.
 */
import type { LunoraClient } from "@lunora/client";
import { api } from "@neore/backend/api";
import Constants from "expo-constants";
import {
    AndroidImportance,
    getExpoPushTokenAsync,
    getPermissionsAsync,
    requestPermissionsAsync,
    setNotificationChannelAsync,
    setNotificationHandler,
} from "expo-notifications";
import { Platform } from "react-native";

import type { PushPlatform, PushServer } from "./push-registration";
import { languageTag, onceItWorks } from "./push-registration";

/** The Android channel phone pushes show on: Expo sends to `default` when a message names none. */
const ANDROID_CHANNEL_ID = "default";

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

/** The Android notification channel's name, as the system settings show it, in the phone's language. */
export const channelName = (locale: string | undefined): string => {
    const base = locale?.toLowerCase().split(LOCALE_SEPARATOR, 1)[0] ?? "en";

    return Object.hasOwn(CHANNEL_NAMES, base) ? (CHANNEL_NAMES[base] as string) : (CHANNEL_NAMES.en as string);
};

/** The EAS project the Expo push token belongs to (`app.config.ts`, from `EAS_PROJECT_ID`). */
const easProjectId = (): string | undefined => {
    const fromBuild = Constants.easConfig?.projectId ?? (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;

    return typeof fromBuild === "string" && fromBuild.length > 0 ? fromBuild : undefined;
};

export const devicePushPlatform: PushPlatform = {
    // No Expo project, no token. Android also needs `google-services.json` in the build (`app.config.ts`).
    canReceivePush: easProjectId() !== undefined && (Platform.OS === "ios" || Constants.expoConfig?.extra?.hasFirebaseConfig === true),
    getDeviceToken: async () => {
        const { data } = await getExpoPushTokenAsync({ projectId: easProjectId() });

        return data;
    },
    getPermission: async () => {
        const { canAskAgain, granted } = await getPermissionsAsync();

        return { canAskAgain, granted };
    },
    platform: Platform.OS === "ios" ? "ios" : "android",
    requestPermission: async () => {
        const { granted } = await requestPermissionsAsync();

        return granted;
    },
};

/** `onlineOnly`: a registration made offline is refused, never replayed later for whoever is signed in by then. */
export const backendPushServer = (client: LunoraClient): PushServer => {
    return {
        isEnabled: async () => {
            const { enabled } = await client.query(api.notifications.native_push.getNativePushConfig, {});

            return enabled;
        },
        register: async (platform, token, language) => {
            const { registered } = await client.mutation(
                api.notifications.native_push.registerPushDevice,
                { platform, token, ...language !== undefined && { language } },
                { onlineOnly: true },
            );

            return registered;
        },
        unregister: async (token) => {
            await client.mutation(api.notifications.native_push.unregisterPushDevice, { token }, { onlineOnly: true });
        },
    };
};

/**
 * Once per launch, once it worked: a notification that arrives while the app is open still shows as a banner, and
 * Android gets the channel its pushes show on (Android 8+ shows nothing on a channel that does not exist). A failed
 * step is tried again the next time this is called (the app coming back to the front).
 */
export const configurePhoneNotifications = onceItWorks(async () => {
    setNotificationHandler({
        handleNotification: async () => {
            return { shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true };
        },
    });

    if (Platform.OS === "android") {
        await setNotificationChannelAsync(ANDROID_CHANNEL_ID, { importance: AndroidImportance.HIGH, name: channelName(deviceLocale()) });
    }
});
