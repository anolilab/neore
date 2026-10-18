/**
 * Announces a workflow run that finished while the tab was hidden. Follows the
 * chat reply-ready path (`notifyNative`, no setting): the native shell gets its
 * own notification, and a browser gets the Notification API once the user has
 * allowed it. The notifications feature has no in-page toggle to respect.
 */
import { isNativeShell, notifyNative } from "@/lib/native/bridge";

export type RunNotificationChannel = "browser" | "native" | "none";

const currentPermission = (): NotificationPermission | "unsupported" => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/** Where a finished run is announced. A visible tab already shows its result, so only a hidden one is announced. */
export const runNotificationChannel = ({
    browserPermission,
    documentHidden,
    native,
}: {
    browserPermission: NotificationPermission | "unsupported";
    documentHidden: boolean;
    native: boolean;
}): RunNotificationChannel => {
    if (!documentHidden) return "none";

    if (native) return "native";

    return browserPermission === "granted" ? "browser" : "none";
};

/** Set once the browser prompt has been shown, so a dismissed prompt is not shown again on every load. */
const PROMPTED_KEY = "workflow-run-notification-prompted";

const wasPrompted = (): boolean => {
    try {
        return localStorage.getItem(PROMPTED_KEY) === "1";
    } catch {
        // Storage is blocked (private mode): treat as prompted, so a blocked store cannot prompt on every run.
        return true;
    }
};

/**
 * Asks for notification permission at most once per browser. Call only from a user
 * gesture such as Run: browsers block prompts that are not user-initiated.
 */
export const requestRunNotificationPermission = (): void => {
    if (isNativeShell() || currentPermission() !== "default" || wasPrompted()) return;

    try {
        localStorage.setItem(PROMPTED_KEY, "1");
    } catch {
        // Nothing to remember with: the prompt still goes out, once for this page load.
    }

    try {
        // Older Safari returns no promise, so the `.catch` can throw; the prompt has already shown by then.
        void Notification.requestPermission().catch(() => undefined);
    } catch {
        // No Notification API here: nothing to ask for.
    }
};

export const announceRunFinished = ({ tag, title }: { tag: string; title: string }): void => {
    const channel = runNotificationChannel({
        browserPermission: currentPermission(),
        documentHidden: document.hidden,
        native: isNativeShell(),
    });

    if (channel === "native") {
        void notifyNative({ title });

        return;
    }

    if (channel !== "browser") return;

    try {
        const notification = new Notification(title, { tag });

        notification.addEventListener("click", () => {
            globalThis.focus();
            notification.close();
        });
    } catch {
        // Android Chrome throws "Illegal constructor" here; the notification is best-effort.
    }
};
