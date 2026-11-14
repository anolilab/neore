/**
 * Android's data-only phone push. The message carries only ids, so expo-notifications runs this task (foreground,
 * background or terminated) instead of showing anything; the task fetches the text and shows the notification itself
 * (`showDataOnlyPush`).
 *
 * Loaded first, from the app entry (`index.ts`): a background task must be defined at module scope before the app
 * starts, or a push that launches the app finds no task.
 */
import { AndroidImportance, dismissNotificationAsync, registerTaskAsync, scheduleNotificationAsync, setNotificationChannelAsync } from "expo-notifications";
import { defineTask } from "expo-task-manager";
import { Platform } from "react-native";

import { secureGrantStore } from "../auth/secure-store";
import { loadConfig } from "../lib/config";
import { ANDROID_CHANNEL_ID, channelName, deviceLocale } from "./push-channel";
import type { PushText } from "./push-content";
import { dataOnlyPushIds, fetchPushContent, PHONE_PUSH_TASK, pushPlaceholder, showDataOnlyPush } from "./push-content";
import type { PushIds } from "./push-registration";

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
            // eslint-disable-next-line no-console -- no logger in a background task; a lost push must not be silent
            console.warn("The push notification task could not run.", error);

            return;
        }

        const locale = deviceLocale();

        // Keyed by the notification: a send that runs twice replaces the first alert instead of adding a second.
        const post = async (text: PushText, ids: PushIds) => {
            await scheduleNotificationAsync({
                content: { ...text, data: { ...ids } },
                identifier: ids.notificationId,
                trigger: { channelId: ANDROID_CHANNEL_ID },
            });
        };

        try {
            const { lunoraUrl } = loadConfig();

            await showDataOnlyPush(data, {
                fetchContent: async (grant, notificationId) => await fetchPushContent({ fetch, grant, lunoraUrl, notificationId }),
                locale,
                // The task can run with no screen up: the channel may not exist yet in this process.
                prepare: async () => {
                    await setNotificationChannelAsync(ANDROID_CHANNEL_ID, { importance: AndroidImportance.HIGH, name: channelName(locale) });
                },
                retract: async (ids) => {
                    await dismissNotificationAsync(ids.notificationId);
                },
                session: async () => await secureGrantStore.get() ?? undefined,
                show: post,
            });
        } catch (taskError) {
            // eslint-disable-next-line no-console -- no logger in a background task; a lost push must not be silent
            console.warn("Could not show a push notification.", taskError);

            // The push was read and nothing is shown for it: post the placeholder without its chat, keyed like the real alert,
            // so the notification is not lost. It carries no text and no chat, so it is safe whoever is signed in.
            const ids = dataOnlyPushIds(data);

            if (ids) {
                try {
                    await post(pushPlaceholder(locale), { notificationId: ids.notificationId });
                } catch (fallbackError) {
                    // eslint-disable-next-line no-console -- no logger in a background task; a lost push must not be silent
                    console.warn("Could not show the placeholder for a push notification.", fallbackError);
                }
            }
        }
    });

    // eslint-disable-next-line unicorn/prefer-top-level-await -- Hermes has no top-level await; the app must not wait on this
    registerPushTask();
}
