/**
 * Whether a user row saved before `appWrittenTextPart` existed holds a prompt the app wrote, told by what its writer leaves
 * in the row: the fixed opening of the prompt it builds, inside the kind of thread it writes to, or the first prompt of a
 * thread that only a run opens. Read by the backfill that clears their `typedText` (`migrations.ts#clearAppWrittenTypedText`);
 * new rows carry the mark instead. `app-written-prompts.test.ts` pins each opening against the builder that writes it, so a
 * reworded builder fails there rather than leaving its old rows typed.
 */

/** The opening of a pull request chat's first message (`source-control/pr-threads.ts`). */
export const PULL_REQUEST_OPENER = "Work on this pull request: ";

// `tasks/logic.ts#buildTaskPrompt`: a task's instructions, wherever the run writes them (a task's thread, or a chat it continues).
const TASK_OPENING = "You are working autonomously on a task. No human is available to answer questions";
// `chat/goals/logic.ts#buildGoalContinuationPrompt`: a goal's later round, in any thread.
const GOAL_ROUND_OPENING = "Goal: ";
const GOAL_ROUND_REVIEW = "\n\nA reviewer checked your last turn and found the goal is not met yet.";
// `sub-agents/logic.ts#buildSubAgentPrompt`: a lead's brief, alone or after the worker's role (`host-runs.ts#promptOf`).
const BRIEF_OPENING = "Task delegated to you:\n\n";
const ROLE_OPENING = "ROLE: ";
// `source-control/pr-watch-wake.ts#wakePrompt`: in whichever chat the pull request is linked to.
const WAKE_OPENING = "[Pull request watch] ";
// `source-control/guide-prompt.ts#buildHostGuidePrompt`: the guide's turn on a paired computer.
const HOST_GUIDE_OPENING = "You write a reading guide for one pull request.";
const PULL_REQUEST_OPENER_RE = /^Work on this pull request: \S+$/u;

/** Threads only a run opens: their first prompt (order 0) is the run's. A person's later reply has a later order. */
const RUN_OPENED_TAGS: ReadonlySet<string> = new Set(["eval", "trigger"]);

/** An opening that names its writer alone, in any thread: no thread read is needed. */
export const isAppWrittenByText = (text: string): boolean =>
    text.startsWith(TASK_OPENING) ||
    (text.startsWith(GOAL_ROUND_OPENING) && text.includes(GOAL_ROUND_REVIEW)) ||
    text.startsWith(WAKE_OPENING) ||
    text.startsWith(HOST_GUIDE_OPENING);

/** Whether the row needs its thread's tags to be judged: a first prompt, or an opening its writer leaves in one kind of thread. */
export const needsThreadTags = (row: { order: number; text: string }): boolean =>
    row.order === 0 || row.text.startsWith(BRIEF_OPENING) || row.text.startsWith(ROLE_OPENING) || PULL_REQUEST_OPENER_RE.test(row.text);

/** Whether a user row in a thread with `tags` holds a prompt the app wrote. */
export const isAppWrittenInThread = (row: { order: number; text: string }, tags: ReadonlyArray<string>): boolean => {
    const { order, text } = row;

    if (isAppWrittenByText(text) || (order === 0 && tags.some((tag) => RUN_OPENED_TAGS.has(tag)))) {
        return true;
    }

    if (tags.includes("sub-agent")) {
        return text.startsWith(BRIEF_OPENING) || (text.startsWith(ROLE_OPENING) && text.includes(`\n\n${BRIEF_OPENING}`));
    }

    return tags.includes("develop") && PULL_REQUEST_OPENER_RE.test(text);
};
