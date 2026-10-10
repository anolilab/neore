/**
 * The headline a push notification shows. Push is rendered by the service
 * worker from the payload alone, so it cannot use the page's locale catalog;
 * English here, and the in-app inbox words the same types in the viewer's
 * language (`features/notifications/lib/notification-labels.ts`).
 */
const HEADLINES: Record<string, { failure?: string; success: string }> = {
    ask_user: { success: "A question is waiting for you" },
    chat_import: { failure: "Chat import failed", success: "Chat import finished" },
    coding_agent: { failure: "Coding agent run failed", success: "Coding agent run finished" },
    daily_brief: { success: "Your daily brief" },
    data_export: { failure: "Data export failed", success: "Your data export is ready" },
    eval: { failure: "Eval run failed", success: "Eval run finished" },
    sub_agent: { failure: "Sub-agent failed", success: "Sub-agent finished" },
    task: { failure: "Task failed", success: "Task finished" },
    tool_approval: { success: "A tool call needs your approval" },
    trigger: { failure: "Trigger run failed", success: "Trigger run finished" },
};

export const pushTitle = (type: string, outcome: "failure" | "success" | undefined): string => {
    const headline = HEADLINES[type];

    if (!headline) {
        return "Neore";
    }

    return outcome === "failure" ? (headline.failure ?? headline.success) : headline.success;
};

/**
 * A run blocked on the user (a tool call to approve, a question to answer) is
 * pushed `high`, so a dozing phone wakes for it; everything else waits for the
 * device's next convenient moment.
 */
export const pushUrgency = (type: string): "high" | "normal" => (type === "tool_approval" || type === "ask_user" ? "high" : "normal");
