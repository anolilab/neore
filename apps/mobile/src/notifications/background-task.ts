/**
 * Android's data-only phone push. The message carries only ids, so expo-notifications
 * runs this task (foreground, background or terminated) instead of showing anything;
 * the task fetches the text and shows the notification itself (`showDataOnlyPush`).
 *
 * Loaded first, from the app entry (`index.ts`): a background task must be defined at
 * module scope before the app starts, or a push that launches the app finds no task.
 */
import { AndroidImportance, dismissNotificationAsync, registerTaskAsync, scheduleNotificationAsync, setNotificationChannelAsync } from "expo-notifications";
import { defineTask } from "expo-task-manager";
import { Platform } from "react-native";

import { secureGrantStore } from "../auth/secure-store";
import { loadConfig } from "../lib/config";
import { channelName, deviceLocale, fetchPushContent, showDataOnlyPush } from "./push-content";

export const PHONE_PUSH_TASK = "neore-phone-push";

/** The Android channel phone pushes show on. */
export const ANDROID_CHANNEL_ID = "default";

const registerPushTask = async (): Promise<void> => {
    try {
        await registerTaskAsync(PHONE_PUSH_TASK);
    } catch (registerError) {
        // eslint-disable-next-line no-console -- no logger this early; a push task that never runs must not be silent
        console.warn("Could not register the push notification task.", registerError);
    }
};

if (Platform.OS === "android") {
    defineTask(PHONE_PUSH_TASK, async ({ data, error }) => {
        if (error) {
            return;
        }

        try {
            const { lunoraUrl } = loadConfig();

            await showDataOnlyPush(data, {
                fetchContent: async (notificationId) => await fetchPushContent({ fetch, lunoraUrl, notificationId, store: secureGrantStore }),
                locale: deviceLocale(),
                // The task can run with no screen up: the channel may not exist yet in this process.
                prepare: async () => {
                    await setNotificationChannelAsync(ANDROID_CHANNEL_ID, { importance: AndroidImportance.HIGH, name: channelName(deviceLocale()) });
                },
                retract: async (ids) => {
                    await dismissNotificationAsync(ids.notificationId);
                },
                sessionUserId: async () => {
                    const grant = await secureGrantStore.get();

                    return grant?.user.id;
                },
                show: async (text, ids) => {
                    // Keyed by the notification: a send that runs twice replaces the first alert instead of adding a second.
                    await scheduleNotificationAsync({
                        content: { ...text, data: { ...ids } },
                        identifier: ids.notificationId,
                        trigger: { channelId: ANDROID_CHANNEL_ID },
                    });
                },
            });
        } catch (taskError) {
            // eslint-disable-next-line no-console -- no logger in a background task; a lost push must not be silent
            console.warn("Could not show a push notification.", taskError);
        }
    });

    // eslint-disable-next-line unicorn/prefer-top-level-await -- Hermes has no top-level await; the app must not wait on this
    registerPushTask();
}
