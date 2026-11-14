/**
 * The backend's register and unregister procedures for this phone's push token, behind the `PushServer` the registration
 * flow takes. Kept apart from `phone-push.ts`, which loads the device's push modules, so the flag it sends can be tested
 * on its own.
 */
import type { LunoraClient } from "@lunora/client";
import { api } from "@neore/backend/api";

import type { PushServer } from "./push-registration";

/** `onlineOnly`: a registration made offline is refused, never replayed later for whoever is signed in by then. */
export const pushServerFor = (client: LunoraClient, isTaskRegistered: () => Promise<boolean>): PushServer => {
    // Read by `isEnabled`, which runs before the sign-out checks that come before `register`: an await inside `register` would
    // let a sign-out start between the last check and the send.
    let isAlertBuilt = false;

    return {
        isEnabled: async () => {
            const { enabled } = await client.query(api.notifications.native_push.getNativePushConfig, {});

            isAlertBuilt = await isTaskRegistered();

            return enabled;
        },
        register: async (platform, token, language) => {
            // Android's alert is built by the background task: the server sends this phone a data-only push only while it runs.
            const buildsAlert = platform === "android" ? isAlertBuilt : undefined;
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
