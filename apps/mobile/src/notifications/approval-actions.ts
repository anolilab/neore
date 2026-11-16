/**
 * The phone side of an approval alert's actions: the category they belong to, and the tap listener that answers them.
 * The category is in `approval-category.ts` and the tap logic in `approval-response.ts` and `approval-tap-listener.ts`; this
 * connects them to expo-notifications.
 *
 * The action titles are in the phone's language (`approval-category.ts`).
 */
import type { NotificationResponse } from "expo-notifications";
import { addNotificationResponseReceivedListener, getLastNotificationResponseAsync, setNotificationCategoryAsync } from "expo-notifications";

import { registerApprovalActionsWith } from "./approval-category";
import type { ApprovalAnswer } from "./approval-response";
import type { ApprovalTapListener } from "./approval-tap-listener";
import { attachApprovalTapListener } from "./approval-tap-listener";

/** Registers the approve and deny actions, titled in `locale`. Called with the other notification setup, once the app has launched. */
export const registerApprovalActions = async (locale?: string): Promise<void> => {
    await registerApprovalActionsWith(async (identifier, actions) => await setNotificationCategoryAsync(identifier, actions), locale);
};

/** Answers approve and deny taps on this device's approval alerts. The caller calls `remove` when the account signs out. */
export const listenForApprovalTaps = (answer: (value: ApprovalAnswer) => Promise<boolean | undefined>): ApprovalTapListener =>
    attachApprovalTapListener(
        {
            addListener: (listener) => addNotificationResponseReceivedListener((response: NotificationResponse) => listener(response)),
            getLast: async () => await getLastNotificationResponseAsync(),
        },
        answer,
    );
