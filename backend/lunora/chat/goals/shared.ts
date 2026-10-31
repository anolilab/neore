/**
 * What the thread view and the backend both need of a goal, free of any server
 * import: the web app reads it through `@neore/backend/chat/goals`.
 */

/** Review rounds a goal gets when the user does not say. */
export const GOAL_DEFAULT_ROUNDS = 5;
/** The most review rounds a user may ask for. */
export const GOAL_MAX_ROUNDS = 10;
/** Longest goal text. */
export const GOAL_TEXT_MAX = 2000;

/** A reasoning effort kept on the 0-100 scale the composer uses; a goal stores it, so a stray value is clamped, not refused. */
export const clampGoalEffort = (effort: number): number => (Number.isFinite(effort) ? Math.min(100, Math.max(0, effort)) : 0);

/**
 * `agentName` of the user-role instruction row a goal saves to open round 2, 3, ...
 * Nobody typed it, so the thread does not show it as a message: it shows the reviewer's note.
 */
export const GOAL_CONTINUATION_AGENT = "neore:goal";

const GOAL_REVIEW_TAG = "goal-review";
const GOAL_REVIEW_NOTE = new RegExp(String.raw`<${GOAL_REVIEW_TAG}(?: taint="([a-z,]*)")?>\n([^\n]*)\n</${GOAL_REVIEW_TAG}>`, "gu");

/**
 * The reviewer's reason as the instruction row carries it: a JSON string inside a tag, so it reads as data. `<` is
 * escaped, which makes it impossible for the reason to close the tag early. `taintedBy` names the untrusted sources
 * (`devices/lib/taint.ts`) the round's tool results came from; device calls read it back so they still prompt.
 */
export const formatGoalReviewNote = (reason: string, taintedBy: ReadonlyArray<string> = []): string => {
    const json = JSON.stringify({ reason }).replaceAll("<", String.raw`\u003c`);
    const attributes = taintedBy.length > 0 ? ` taint="${taintedBy.join(",")}"` : "";

    return `<${GOAL_REVIEW_TAG}${attributes}>\n${json}\n</${GOAL_REVIEW_TAG}>`;
};

/**
 * The reason and taint a row's text carries, or `null` when it holds no note. The note is the LAST thing in the row,
 * so it is the last match: goal text the user typed that looks like a note comes before it and does not win.
 */
export const parseGoalReviewNote = (text: string): { reason: string; taintedBy: string[] } | null => {
    const match = [...text.matchAll(GOAL_REVIEW_NOTE)].at(-1);

    if (!match) {
        return null;
    }

    try {
        const { reason } = JSON.parse(match[2]!) as { reason?: unknown };

        return typeof reason === "string" ? { reason, taintedBy: match[1] ? match[1].split(",") : [] } : null;
    } catch {
        return null;
    }
};

export type GoalStopReason = "cost_limit" | "daily_limit" | "error" | "review_failed" | "round_limit" | "superseded" | "unsupported" | "user";
