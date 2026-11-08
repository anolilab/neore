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
    review_request: { success: "Your review was requested" },
    secret_request: { success: "The assistant is asking for a secret" },
    sub_agent: { failure: "Sub-agent failed", success: "Sub-agent finished" },
    task: { failure: "Task failed", success: "Task finished" },
    tool_approval: { success: "A tool call needs your approval" },
    trigger: { failure: "Trigger run failed", success: "Trigger run finished" },
    usage_alert: { success: "A usage alert was triggered" },
};

export const pushTitle = (type: string, outcome: "failure" | "success" | undefined): string => {
    const headline = HEADLINES[type];

    if (!headline) {
        return "Neore";
    }

    return outcome === "failure" ? (headline.failure ?? headline.success) : headline.success;
};

/**
 * A run blocked on the user (a tool call to approve, a question to answer, a secret to give) is
 * pushed `high`, so a dozing phone wakes for it; everything else waits for the
 * device's next convenient moment.
 */
const WAITING_ON_A_PERSON: ReadonlySet<string> = new Set(["ask_user", "secret_request", "tool_approval"]);

export const pushUrgency = (type: string): "high" | "normal" => (WAITING_ON_A_PERSON.has(type) ? "high" : "normal");

/**
 * The only text a phone push carries through Expo, Apple and Google: a generic
 * alert, the same for every notification. Worded in the phone's language, with
 * the same locales as the web app; English while the phone's language is not
 * known (`userSettings.language` is the language for AI replies, not this).
 */
const PHONE_PLACEHOLDER_BODIES: Readonly<Record<string, string>> = {
    de: "Du hast eine neue Benachrichtigung",
    en: "You have a new notification",
    es: "Tienes una notificación nueva",
    fr: "Vous avez une nouvelle notification",
    it: "Hai una nuova notifica",
    ja: "新しい通知があります",
    pl: "Masz nowe powiadomienie",
    pt: "Você tem uma nova notificação",
    zh: "你有一条新通知",
};

export const PHONE_PLACEHOLDER_TITLE = "Neore";

const LANGUAGE_SEPARATOR = /[-_]/u;

export const phonePlaceholderBody = (language: string | undefined): string => {
    const base = language?.toLowerCase().split(LANGUAGE_SEPARATOR, 1)[0] ?? "en";

    // Own keys only: a language such as `constructor` must not read an inherited property.
    return Object.hasOwn(PHONE_PLACEHOLDER_BODIES, base) ? (PHONE_PLACEHOLDER_BODIES[base] as string) : (PHONE_PLACEHOLDER_BODIES.en as string);
};
