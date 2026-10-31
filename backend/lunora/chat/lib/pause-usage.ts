/**
 * The usage record of a reply, from the rows a run saved: one record per reply (`repliesByOrder`), keyed on its first
 * reply row, so a run that paused and resumed counts once however many invocations wrote the reply.
 *
 * `afterRun` records through this at the end of a run, and so does a pause that never resumes (a stop, a superseded
 * run): the rows it saved before the pause must not be lost.
 */
import { type ReplySkill, repliesByOrder, replyUsageArgs, type SavedRowLike } from "../../usage/activity-logic";
import { scheduleReplyUsage } from "../../usage/schedule";

type Scheduler = Parameters<typeof scheduleReplyUsage>[0];

export const scheduleRepliesUsage = (
    scheduler: Scheduler,
    rows: ReadonlyArray<SavedRowLike>,
    options: { at: number; skill?: ReplySkill; timeZone?: string; userId: string },
): void => {
    for (const reply of repliesByOrder(rows)) {
        scheduleReplyUsage(scheduler, replyUsageArgs(reply, options));
    }
};
