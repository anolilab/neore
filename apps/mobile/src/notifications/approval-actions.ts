/**
 * The phone side of an approval alert's actions: the category they belong to, and the tap listener that answers them.
 * The tap's logic is in `approval-response.ts` and the listener in `approval-tap-listener.ts`; this connects them to expo-notifications.
 *
 * The action titles are English. The app has no localised approval strings yet.
 */
import type { NotificationResponse } from "expo-notifications";
import { addNotificationResponseReceivedListener, getLastNotificationResponseAsync, setNotificationCategoryAsync } from "expo-notifications";

import type { ApprovalAnswer } from "./approval-response";
import { APPROVE_ACTION, DENY_ACTION, TOOL_APPROVAL_CATEGORY } from "./approval-response";
import type { ApprovalTapListener } from "./approval-tap-listener";
import { attachApprovalTapListener } from "./approval-tap-listener";

/** Registers the approve and deny actions. Called with the other notification setup, once the app has launched. */
export const registerApprovalActions = async (): Promise<void> => {
    await setNotificationCategoryAsync(TOOL_APPROVAL_CATEGORY, [
        { buttonTitle: "Approve", identifier: APPROVE_ACTION, options: { opensAppToForeground: false } },
        { buttonTitle: "Deny", identifier: DENY_ACTION, options: { isDestructive: true, opensAppToForeground: false } },
    ]);
};

/** Answers approve and deny taps on this device's approval alerts. The caller calls `remove` when the account signs out. */
export const listenForApprovalTaps = (answer: (value: ApprovalAnswer) => Promise<void>): ApprovalTapListener =>
    attachApprovalTapListener(
        {
            addListener: (listener) => addNotificationResponseReceivedListener((response: NotificationResponse) => listener(response)),
            getLast: async () => await getLastNotificationResponseAsync(),
        },
        answer,
    );
