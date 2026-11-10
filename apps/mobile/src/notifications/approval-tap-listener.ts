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
    /** Settles once the launch response, if any, has been read and answered. */
    launched: Promise<void>;
    remove: () => void;
}

/**
 * Answers each approve or deny tap with `answer`. A tap that opened the app from closed is not delivered to the listener: it is
 * the launch response, read once on subscribe. A tap that reaches the listener and is also the launch response is answered once.
 * A failure is logged without the approval's id or the token.
 */
export const attachApprovalTapListener = (source: TapSource, answer: (value: ApprovalAnswer) => Promise<void>): ApprovalTapListener => {
    let answeredTap: string | undefined;

    const answerTap = async (response: TapResponse): Promise<void> => {
        const { identifier } = response.notification.request;

        if (identifier === answeredTap) {
            return;
        }

        answeredTap = identifier;

        try {
            await answerApprovalFromTap(response, answer);
        } catch {
            // eslint-disable-next-line no-console -- no logger in the app; a failed answer must not be silent
            console.warn("Could not answer the tool approval from its notification.");
        }
    };

    const launched = (async (): Promise<void> => {
        try {
            const launch = await source.getLast();

            if (launch) {
                await answerTap(launch);
            }
        } catch {
            // eslint-disable-next-line no-console -- no logger in the app; a failed read must not be silent
            console.warn("Could not read the notification that opened the app.");
        }
    })();

    const subscription = source.addListener(answerTap);

    return { launched, remove: () => subscription.remove() };
};
