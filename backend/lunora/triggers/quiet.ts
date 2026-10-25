/**
 * Quiet routines: a bot routine that opts in to posting only when there is
 * something to report.
 *
 * "Nothing to report" is the Daily Brief's own signal: `hasBriefContent` over
 * the inputs `loadDailyBriefInputs` reads, so the two cannot disagree on what
 * quiet means. Those inputs are the user's workspace activity since the window
 * start, not the routine's subject. A quiet routine therefore posts whenever the
 * workspace was active in the window, whatever the routine itself watches.
 *
 * The check runs before the run writes anything, so a skipped run creates no
 * thread, sends no notification and is not charged.
 */
import type { BriefInputs } from "../notifications/daily-brief-logic";
import { hasBriefContent } from "../notifications/daily-brief-logic";

/** Where the window starts: the last run that posted, or the routine's creation before any run did. */
export const quietWindowStart = (trigger: { createdAt: number; lastTriggeredAt?: number }): number => trigger.lastTriggeredAt ?? trigger.createdAt;

/**
 * Whether this run is skipped. `loadInputs` is called only for an opted-in
 * routine, so every other run is posted exactly as before.
 */
export const isQuietRunSkipped = async (
    trigger: { createdAt: number; lastTriggeredAt?: number; quietWhenEmpty?: boolean },
    loadInputs: (since: number) => Promise<BriefInputs>,
): Promise<boolean> => {
    if (trigger.quietWhenEmpty !== true) {
        return false;
    }

    return !hasBriefContent(await loadInputs(quietWindowStart(trigger)));
};
