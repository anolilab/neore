/**
 * The tap listener for approval alerts, without the device API: it takes the two expo-notifications calls it needs, so it runs
 * the same in a test. `approval-actions.ts` passes in the real ones.
 */
import type { ApprovalAnswer, NotificationTap } from "./approval-response";
import { answerApprovalFromTap } from "./approval-response";

/** A tap as the listener reads it: the action and the alert's data, plus the alert's identifier. */
export interface TapResponse extends NotificationTap {
    notification: { request: { content: { data?: unknown }; identifier: string } };
}

/** The two expo-notifications calls the listener makes. */
export interface TapSource {
    addListener: (listener: (response: TapResponse) => Promise<void>) => { remove: () => void };
    getLast: () => Promise<TapResponse | null | undefined>;
}

export interface ApprovalTapListener {
    /** Settles once the launch response, if any, has been read and answered (or skipped). */
    launched: Promise<void>;
    remove: () => void;
}

/** What became of a tap: answered, failed (kept for a retry in the app), or not answered by this listener (left for another). */
type TapOutcome = "answered" | "failed" | "not-answered";

/**
 * The taps that were answered, by notification and action. A tap is recorded only once its answer succeeds, so a default tap
 * (which answers nothing) never blocks a later approve or deny, and a refused answer can be retried by a new tap. Shared across
 * listeners, so a tap answered before a restart is not answered again.
 */
const answeredTaps = new Set<string>();

/**
 * The launch responses already read. Expo keeps the last response, so it is read on every subscription. A launch response stays
 * marked once its answer succeeded or failed, so a restart or a new sign-in does not send it again. One that was skipped (not
 * answered, for example during sign-out) is unmarked, so the next listener can answer it.
 */
const replayedLaunches = new Set<string>();

/** The code an error carries, when it has one, for the log: never its message, which can quote an approval id or a token. */
const failureCode = (error: unknown): string => {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
        return error.code;
    }

    return "unknown";
};

const tapKey = (response: TapResponse): string => `${response.notification.request.identifier}\u{0}${response.actionIdentifier}`;

/**
 * Answers each approve or deny tap with `answer`. A tap that opened the app from closed is not delivered to the listener: it is
 * the launch response, read on subscribe and handled once. A tap that is also the launch response is answered once, and a tap
 * already answered is not answered again. Two deliveries of the same tap at the same moment answer once. After `remove`, no tap is
 * answered, including a launch response that was still being read.
 */
export const attachApprovalTapListener = (
    source: TapSource,
    answer: (value: ApprovalAnswer) => Promise<boolean | undefined>,
    answered: Set<string> = answeredTaps,
    replayed: Set<string> = replayedLaunches,
): ApprovalTapListener => {
    let isActive = true;
    // The answer in flight for each tap: a second delivery of the same tap waits for its outcome rather than reporting its own.
    const inFlight = new Map<string, Promise<TapOutcome>>();

    // "answered" and "failed" settle the tap for good (a failed one is kept for the user to retry in the app); "not-answered" is a
    // tap this listener did not answer, and is left for another listener to read.
    const answerOnce = async (response: TapResponse, key: string): Promise<TapOutcome> => {
        try {
            if (await answerApprovalFromTap(response, answer)) {
                answered.add(key);

                return "answered";
            }

            return "not-answered";
        } catch (error: unknown) {
            // eslint-disable-next-line no-console -- no logger in the app; a failed answer must not be silent
            console.warn(`Could not answer the tool approval from its notification (${failureCode(error)}).`);

            return "failed";
        }
    };

    const answerTap = async (response: TapResponse): Promise<TapOutcome> => {
        const key = tapKey(response);

        if (answered.has(key)) {
            return "answered";
        }

        if (!isActive) {
            return "not-answered";
        }

        const pending = inFlight.get(key);

        if (pending !== undefined) {
            return await pending;
        }

        const attempt = answerOnce(response, key);

        inFlight.set(key, attempt);

        try {
            return await attempt;
        } finally {
            inFlight.delete(key);
        }
    };

    const launched = (async (): Promise<void> => {
        try {
            const launch = await source.getLast();

            if (launch && !replayed.has(launch.notification.request.identifier)) {
                const launchId = launch.notification.request.identifier;

                // Marked while its answer is in flight, so no other listener reads it too; unmarked again when it was skipped, so the
                // next listener (after a sign-in, say) can answer it.
                replayed.add(launchId);

                const outcome = await answerTap(launch);

                if (outcome === "not-answered") {
                    replayed.delete(launchId);
                }
            }
        } catch {
            // eslint-disable-next-line no-console -- no logger in the app; a failed read must not be silent
            console.warn("Could not read the notification that opened the app.");
        }
    })();

    const subscription = source.addListener(async (response: TapResponse): Promise<void> => {
        await answerTap(response);
    });

    return {
        launched,
        remove: () => {
            isActive = false;
            subscription.remove();
        },
    };
};
