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
 *
 * The window starts at `lastTriggeredAt`, which a run sets once it has reached the
 * agent and either completed or failed, a manual "Run now" included. A skipped run
 * and a run refused at admission (daily limit, disallowed model) do not move it.
 *
 * The check runs before the run writes anything, so a skipped run creates no
 * thread, sends no notification and is not charged.
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
    /** A locked chat has no title here, so it never counts. A routine's own run threads are not listed. */
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

/** Where the window starts: the last run that reached the agent (completed or failed), or the routine's creation before any. */
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
