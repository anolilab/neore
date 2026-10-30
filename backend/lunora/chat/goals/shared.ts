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

/**
 * `agentName` of the user-role instruction row a goal saves to open round 2, 3, ...
 * Nobody typed it, so the thread does not show it as a message.
 */
export const GOAL_CONTINUATION_AGENT = "neore:goal";

export type GoalStopReason = "cost_limit" | "daily_limit" | "error" | "review_failed" | "round_limit" | "superseded" | "unsupported" | "user";
