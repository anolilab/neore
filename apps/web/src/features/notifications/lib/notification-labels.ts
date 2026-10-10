import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";

export type NotificationType =
    "ask_user" | "chat_import" | "coding_agent" | "daily_brief" | "data_export" | "eval" | "sub_agent" | "task" | "tool_approval" | "trigger";

export interface NotificationLike {
    outcome?: "failure" | "success";
    type: NotificationType;
}

/**
 * The headline of a notification in the viewer's language. The server stores
 * the subject (a task's title, a trigger's name) as `title`; what happened to
 * it is worded here. Push, which cannot reach this catalog, words the same
 * types in `backend/lunora/notifications/push-text.ts`.
 */
const useNotificationHeadline = (): ((notification: NotificationLike) => string) => {
    const { t } = useLingui();

    return useCallback(
        ({ outcome, type }: NotificationLike): string => {
            const failed = outcome === "failure";

            switch (type) {
                case "ask_user": {
                    return t`A question is waiting for you`;
                }
                case "chat_import": {
                    return failed ? t`Chat import failed` : t`Chat import finished`;
                }
                case "coding_agent": {
                    return failed ? t`Coding agent run failed` : t`Coding agent run finished`;
                }
                case "daily_brief": {
                    return t`Your daily brief`;
                }
                case "data_export": {
                    return failed ? t`Data export failed` : t`Your data export is ready`;
                }
                case "eval": {
                    return failed ? t`Eval run failed` : t`Eval run finished`;
                }
                case "sub_agent": {
                    return failed ? t`Sub-agent failed` : t`Sub-agent finished`;
                }
                case "task": {
                    return failed ? t`Task failed` : t`Task finished`;
                }
                case "tool_approval": {
                    return t`A tool call needs your approval`;
                }
                case "trigger": {
                    return failed ? t`Trigger run failed` : t`Trigger run finished`;
                }
                default: {
                    return t`Notification`;
                }
            }
        },
        [t],
    );
};

export default useNotificationHeadline;
