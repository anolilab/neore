/**
 * The device and server halves of push for `push-registration.ts`: the system's
 * permission and the Expo push token through expo-notifications, and the backend's
 * register and unregister procedures. A push carries only a generic alert and ids.
 */
import type { LunoraClient } from "@lunora/client";
import { api } from "@neore/backend/api";
import Constants from "expo-constants";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import {
    AndroidImportance,
    cancelAllScheduledNotificationsAsync,
    dismissAllNotificationsAsync,
    getExpoPushTokenAsync,
    getPermissionsAsync,
    requestPermissionsAsync,
    setNotificationChannelAsync,
    setNotificationHandler,
} from "expo-notifications";
import { getItemAsync, setItemAsync } from "expo-secure-store";
import { isTaskRegisteredAsync } from "expo-task-manager";
import { Platform } from "react-native";

import { sharedKeychainOps } from "../auth/secure-store";
import { writeIfDifferent } from "../auth/shared-keychain";
import { loadConfig } from "../lib/config";
import { registerApprovalActions } from "./approval-actions";
import { pushTaskRegistration } from "./background-task";
import { clearTapRoute } from "./pending-tap";
import { ANDROID_CHANNEL_ID, channelName, deviceLocale } from "./push-channel";
import { isDataOnlyPush, PHONE_PUSH_TASK } from "./push-content";
import type { PushPlatform, PushServer } from "./push-registration";
import { createPendingWork, createSerialSteps, noteAccountOnPhone, onceItWorks } from "./push-registration";

/** Registrations in flight; sign-out settles them before it releases the token. */
export const pushRegistrations = createPendingWork();

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

/** Whether this build's background task is registered: the phone builds its own Android alerts only while it is. */
const isPhoneTaskRegistered = async (): Promise<boolean> => {
    try {
        // The first registration can run before the task has registered: wait for that attempt, or the phone
        // reads as built without it.
        await pushTaskRegistration();

        return await isTaskRegisteredAsync(PHONE_PUSH_TASK);
    } catch {
        return false;
    }
};

/** `onlineOnly`: a registration made offline is refused, never replayed later for whoever is signed in by then. */
export const backendPushServer = (client: LunoraClient): PushServer => {
    return {
        isEnabled: async () => {
            const { enabled } = await client.query(api.notifications.native_push.getNativePushConfig, {});

            return enabled;
        },
        register: async (platform, token, language) => {
            // Android's alert is built by the background task: the server sends this phone a data-only push only while it runs.
            const buildsAlert = platform === "android" ? await isPhoneTaskRegistered() : undefined;
            const { registered } = await client.mutation(
                api.notifications.native_push.registerPushDevice,
                { platform, token, ...language !== undefined && { language }, ...buildsAlert !== undefined && { buildsAlert } },
                { onlineOnly: true },
            );

            return registered;
        },
        unregister: async (token) => {
            await client.mutation(api.notifications.native_push.unregisterPushDevice, { token }, { onlineOnly: true });
        },
    };
};

/** The backend's address, for the notification extension: it reads it from the shared keychain group to fetch a push's text. */
const EXTENSION_LUNORA_URL_KEY = "neore.mobile.lunora-url";

/**
 * Once per launch, once it worked: a notification that arrives while the app is open still shows as a banner, and
 * Android gets the channel its pushes show on (Android 8+ shows nothing on a channel that does not exist). A failed
 * step is tried again the next time this is called (the app coming back to the front).
 */
export const configurePhoneNotifications = onceItWorks(async () => {
    setNotificationHandler({
        handleNotification: async ({ request }) => {
            // A data-only push shows no banner of its own: the task posts its alert, and the system's would be blank.
            const isSilent = isDataOnlyPush(request.trigger);

            return { shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: !isSilent, shouldShowList: !isSilent };
        },
    });

    if (Platform.OS === "android") {
        await setNotificationChannelAsync(ANDROID_CHANNEL_ID, { importance: AndroidImportance.HIGH, name: channelName(deviceLocale()) });
    }
});

/**
 * Gives the notification extension the backend's address on every setup, not only the first: a write that failed before
 * is tried again. It never fails setup: the approval actions do not depend on it.
 */
export const syncExtensionAddress = async (): Promise<void> => {
    if (Platform.OS !== "ios") {
        return;
    }

    try {
        await writeIfDifferent(EXTENSION_LUNORA_URL_KEY, loadConfig().lunoraUrl, sharedKeychainOps);
    } catch (error) {
        // eslint-disable-next-line no-console -- no logger in the app; a failed write must not be silent
        console.warn("Could not give the notification extension the server address.", error);
    }
};

/** The language the approval actions were last registered in, once they were: a change of language registers them again. */
const approvalActionsState = { isRegistered: false, locale: undefined as string | undefined };

/** The last sync to finish, so the next one starts after it: two syncs never register at once, and the last one to start wins. */
const approvalActionsQueue: { last: Promise<void> } = { last: Promise.resolve() };

const registerActionsInCurrentLanguage = async (): Promise<void> => {
    const locale = deviceLocale();

    if (approvalActionsState.isRegistered && approvalActionsState.locale === locale) {
        return;
    }

    await registerApprovalActions(locale);

    approvalActionsState.isRegistered = true;
    approvalActionsState.locale = locale;
};

/**
 * Registers the approve and deny actions in the phone's current language, unless they already are. Called before every
 * registration, so a language change reaches the buttons on the next foreground without an app restart. A failure is raised, so the
 * registration waits and is tried again. Overlapping calls run one after another, so an older language cannot finish last.
 */
export const syncApprovalActions = async (): Promise<void> => {
    const previous = approvalActionsQueue.last;
    const turn: { done?: () => void } = {};

    approvalActionsQueue.last = new Promise<void>((resolve) => {
        turn.done = resolve;
    });

    try {
        await previous;
        await registerActionsInCurrentLanguage();
    } finally {
        turn.done?.();
    }
};

/** Removes the alerts still on this phone. */
export const dismissAccountNotifications = async (): Promise<void> => {
    clearTapRoute();
    // Queued alerts too: the task's alerts for the account being removed must not appear after its sign-out. The dismiss runs
    // even when the cancel fails, so an alert already shown does not stay up.
    try {
        await cancelAllScheduledNotificationsAsync();
    } finally {
        await dismissAllNotificationsAsync();
    }
};

/** Records the account signed in on this phone; `onSwitch` removes the previous person's alerts first when it differs. */
/** Every read and write of the record, one at a time, in the order they were asked for. */
const recordSteps = createSerialSteps();

export const noteSignedInAccount = async (userId: string, onSwitch: () => Promise<void>, isCurrent: () => boolean): Promise<void> =>
    await noteAccountOnPhone(
        userId,
        {
            digest: async (value) => await digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
            read: async (key) => await recordSteps(async () => await getItemAsync(key)),
            write: async (key, value) => await recordSteps(async () => await setItemAsync(key, value)),
        },
        onSwitch,
        isCurrent,
    );
