/**
 * The device and server halves of push for `push-registration.ts`: the system's
 * permission and the Expo push token through expo-notifications, and the backend's
 * register and unregister procedures. Pushes come through Expo's push service and
 * carry only ids; the text is fetched from our backend before it shows
 * (`push-content.ts`, and the iOS Notification Service Extension).
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

import { sharedKeychainOps } from "../auth/secure-store";
import { writeIfDifferent } from "../auth/shared-keychain";
import { loadConfig } from "../lib/config";
import { ANDROID_CHANNEL_ID } from "./background-task";
import { channelName, deviceLocale } from "./push-content";
import type { PushPlatform, PushServer } from "./push-registration";
import { createPendingWork, onceItWorks } from "./push-registration";

/** Registrations in flight; sign-out settles them before it releases the token. */
export const pushRegistrations = createPendingWork();

/** The keychain item the iOS Notification Service Extension reads the backend URL from (`NotificationService.swift`). */
const EXTENSION_LUNORA_URL_KEY = "neore.mobile.lunora-url";

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
        register: async (platform, token) => {
            const { registered } = await client.mutation(api.notifications.native_push.registerPushDevice, { platform, token }, { onlineOnly: true });

            return registered;
        },
        unregister: async (token) => {
            await client.mutation(api.notifications.native_push.unregisterPushDevice, { token }, { onlineOnly: true });
        },
    };
};

/**
 * Once per launch, once it worked: a notification that arrives while the app is open
 * still shows as a banner; Android gets the channel its pushes show on (Android 8+
 * shows nothing on a channel that does not exist); and the iOS extension learns where
 * the backend is. The session it signs in with is the app's own keychain item, shared
 * through the keychain access group (`app.config.ts`). A failed step is tried again
 * the next time this is called (the app coming back to the front).
 */
export const configurePhoneNotifications = onceItWorks(async () => {
    setNotificationHandler({
        handleNotification: async () => {
            return { shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true };
        },
    });

    if (Platform.OS === "android") {
        await setNotificationChannelAsync(ANDROID_CHANNEL_ID, { importance: AndroidImportance.HIGH, name: channelName(deviceLocale()) });
    } else {
        await writeIfDifferent(EXTENSION_LUNORA_URL_KEY, loadConfig().lunoraUrl, sharedKeychainOps);
    }
});
