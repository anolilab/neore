/**
 * Quiet routines: a bot routine that opts in to posting only when there is
 * something to report.
 *
 * "Nothing to report" is the Daily Brief's own signal, `hasBriefContent`, over
 * the user's workspace activity since the window start (`QuietSnapshot`, read by
 * `quiet-inputs.ts`). It is not the routine's subject: a quiet routine posts
 * whenever the workspace was active in the window, whatever the routine itself
 * watches. Differences from the brief, which has no routine of its own to
 * exclude:
 *  - every item must be NEWER than the window start, open requests and running
 *    work included, so one approval left open for a week does not make every run
 *    post;
 *  - other routines' own output does not count (their "trigger" notifications and
 *    their run threads, which carry {@link TRIGGER_THREAD_TAG}), or two quiet
 *    routines would wake each other forever. A thread is a run's by that tag, set
 *    when the run creates it, never by its title: a user can rename any chat.
 *    The exception is a user's own reply in such a thread (a user message past
 *    the run's prompt): that is the user working in the routine's chat, and counts.
 *
 * The window starts at `lastTriggeredAt`: the moment the last run began its agent
 * (not when it ended, so what happened while the agent worked is reported by the
 * next run). A run sets it once its thread exists, whether it then completed or
 * failed, a manual "Run now" included. A skipped run, a run refused at admission
 * (daily limit, disallowed model), a thrown admission error and a failure before
 * the thread was created do not move it: they posted nothing, so the activity
 * that prompted them is still unreported. It only moves forward: a run that
 * started earlier but finishes last leaves a later start in place.
 *
 * The check runs before the run writes anything, so a skipped run creates no
 * thread, sends no notification and is not charged.
 *
 * A run that passes the check takes its window at once (`reserveQuietWindow`
 * moves `lastTriggeredAt` to the window start), before admission and the thread.
 * Runs of one routine can overlap (the next slot starts while the agent still
 * works), and both would otherwise read the same unmoved window and post the same
 * activity twice. The run that loses the swap is recorded as skipped. A run that
 * then posts nothing gives the window back, so the "do not move it" rule above holds: the give-back moves the window
 * to the value the run replaced even when a later run has moved it on since, so that run's activity is read again
 * rather than missed. A failed give-back is scheduled again. A run that took the window never stamps it a second time.
 */
import type { Doc } from "../_generated/dataModel";
import type { BriefInputs } from "../notifications/daily-brief-logic";
import { hasBriefContent } from "../notifications/daily-brief-logic";

type TriggerType = Doc<"triggers">["type"];

/** A notification of this type is not workspace activity here: routines would wake each other, and the brief is not news. */
export const QUIET_IGNORED_EVENT_TYPES = ["daily_brief", "trigger"] as const;

/**
 * The system label (`threads.tags`) of a routine's run thread. Set at creation by
 * `executeTrigger`; a user cannot write `tags`, so it, unlike the title, cannot be
 * given to an ordinary chat.
 */
export const TRIGGER_THREAD_TAG = "trigger";

/**
 * The one rule for which routines may be quiet: a scheduled routine that runs as
 * a bot. A webhook delivery is never skipped (the workspace signal would drop a
 * real event), and a routine with no bot has no model or instructions to post as.
 */
export const canBeQuiet = (routine: { botId: string | undefined; type: TriggerType }): boolean => Boolean(routine.botId) && routine.type === "schedule";

/** What the workspace holds, each item with the time it last changed. `quietBriefInputs` applies the window. */
export interface QuietSnapshot {
    /** No title: a notification's text can name a locked chat, and only its existence counts here. */
    events: { createdAt: number; type: string }[];
    /** Open requests for the user. `at` is when the request arose or last changed. */
    needsYou: { at: number; kind: string; title: string }[];
    running: { at: number; kind: string; title: string }[];
    /** A locked chat has no title here, so it never counts. A routine's run thread is listed only for a reply of the user's. */
    threads: { title?: string; updatedAt: number }[];
}

/** The snapshot as the brief's inputs: only what is newer than `since`. The reader leaves out the routines' own threads. */
export const quietBriefInputs = (snapshot: QuietSnapshot, since: number): BriefInputs => {
    const ignored: ReadonlyArray<string> = QUIET_IGNORED_EVENT_TYPES;

    return {
        events: snapshot.events
            .filter((event) => event.createdAt > since && !ignored.includes(event.type))
            .map((event) => {
                return { title: "", type: event.type };
            }),
        needsYou: snapshot.needsYou.filter((item) => item.at > since),
        running: snapshot.running.filter((item) => item.at > since),
        threads: snapshot.threads.flatMap((thread) => (thread.updatedAt > since && thread.title ? [thread.title] : [])),
    };
};

/** Where the window starts: when the last run that created its thread began, or the routine's creation before any. */
export const quietWindowStart = (trigger: { createdAt: number; lastTriggeredAt?: number }): number => trigger.lastTriggeredAt ?? trigger.createdAt;

/**
 * Whether this run is skipped. `loadSnapshot` is called only for an opted-in
 * routine that can be quiet, so every other run is posted exactly as before.
 * `botId` is the bot the run will actually use: pass undefined when it is gone,
 * and the stale flag then posts. A manual "Run now" is never skipped: the user
 * asked for it and is waiting for a chat.
 */
export const isQuietRunSkipped = async (
    trigger: { botId: string | undefined; createdAt: number; lastTriggeredAt?: number; quietWhenEmpty?: boolean; type: TriggerType },
    loadSnapshot: (since: number) => Promise<QuietSnapshot>,
    { manual }: { manual: boolean },
): Promise<boolean> => {
    if (manual || trigger.quietWhenEmpty !== true || !canBeQuiet(trigger)) {
        return false;
    }

    const since = quietWindowStart(trigger);

    return !hasBriefContent(quietBriefInputs(await loadSnapshot(since), since));
};
