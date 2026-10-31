/**
 * "Run until done" for a headless run (a trigger, a task, a messenger reply) that
 * opts in through `HeadlessRunOptions.goal`. Defaults are unchanged: without the
 * option a headless run is one `generateText`.
 *
 * Unlike an interactive goal, whose every round is a claimed job on the jobs
 * queue, the rounds here run inside the caller's invocation — a headless caller
 * already holds its own claim (a trigger's, a task round's) and has no chat to
 * show a round to. So the loop carries two limits an interactive goal does not
 * need: a wall-clock budget (the scheduler's alarm lives 15 minutes; no round
 * starts after the budget is spent), and the same round and cost caps.
 */
import { buildGoalContinuationPrompt, buildGoalTranscript, clampGoalRounds, decideGoalRound, GOAL_MAX_COST_MICRODOLLARS, type GoalVerdict } from "./logic";
import type { GoalStopReason } from "./shared";

/** No round starts after this: a scheduled action may live 15 minutes, and a round takes minutes itself. */
export const HEADLESS_GOAL_BUDGET_MS = 8 * 60 * 1000;

export type HeadlessGoalStop = GoalStopReason | "time_limit";

/** What one round of the run produced. */
export interface GoalRoundResult {
    costMicrodollars: number;
    text: string;
    totalTokens: number;
    /** The round as the reviewer reads it (`buildGoalTranscript` rows). */
    transcript: string;
}

export interface HeadlessGoalOutcome {
    costMicrodollars: number;
    /** Why the loop ended: `met`, or the limit it hit. */
    ended: "met" | HeadlessGoalStop;
    /** The reviewer's last reason. */
    reason: string;
    /** The last round's result. */
    result: GoalRoundResult;
    rounds: number;
    totalTokens: number;
}

export const runHeadlessGoalRounds = async (input: {
    budgetMs?: number;
    /** Charges the next round to the user's daily limits; `false` when they are spent. */
    charge: () => Promise<boolean>;
    first: GoalRoundResult;
    goal: { maxCostMicrodollars?: number; maxRounds?: number; text: string };
    now?: () => number;
    /** One utility-model review of a round. Throws when the reviewer is unavailable. */
    review: (args: { round: number; transcript: string }) => Promise<GoalVerdict & { costMicrodollars: number }>;
    /** Runs another round in the same thread with `prompt` as the next instruction. */
    runRound: (prompt: string) => Promise<GoalRoundResult>;
    /** When the run began (before its first generation), which is where the time budget starts. Default: now. */
    startedAt?: number;
    /** Asked before each further round: `true` ends the goal there (a sub-agent run that was cancelled). */
    stopped?: () => Promise<boolean>;
}): Promise<HeadlessGoalOutcome> => {
    const now = input.now ?? Date.now;
    const deadline = (input.startedAt ?? now()) + (input.budgetMs ?? HEADLESS_GOAL_BUDGET_MS);
    const maxRounds = clampGoalRounds(input.goal.maxRounds);
    const maxCostMicrodollars = input.goal.maxCostMicrodollars ?? GOAL_MAX_COST_MICRODOLLARS;
    let result = input.first;
    let { costMicrodollars } = result;
    let { totalTokens } = result;
    let reason = "";

    for (let round = 1; ; round += 1) {
        const finish = (ended: HeadlessGoalOutcome["ended"]): HeadlessGoalOutcome => {
            return { costMicrodollars, ended, reason, result, rounds: round, totalTokens };
        };

        // A run stopped while its round generated is not reviewed: no reviewer call, and no win reported for it.
        if (await input.stopped?.()) {
            return finish("user");
        }

        let verdict: GoalVerdict & { costMicrodollars: number };

        try {
            verdict = await input.review({ round, transcript: result.transcript });
        } catch {
            return finish("review_failed");
        }

        costMicrodollars += verdict.costMicrodollars;
        reason = verdict.reason;

        const decision = decideGoalRound({ costMicrodollars, maxCostMicrodollars, maxRounds, met: verdict.met, round });

        if (decision !== "continue") {
            return finish(decision);
        }

        if (await input.stopped?.()) {
            return finish("user");
        }

        if (now() >= deadline) {
            return finish("time_limit");
        }

        if (!(await input.charge())) {
            return finish("daily_limit");
        }

        result = await input.runRound(buildGoalContinuationPrompt({ goal: input.goal.text, reason }));
        costMicrodollars += result.costMicrodollars;
        totalTokens += result.totalTokens;
    }
};

/** The reviewer's view of one `generateText` result: each step's text and tool results, never a tool call's input. */
export const stepsTranscript = (steps: ReadonlyArray<{ text?: string; toolResults?: ReadonlyArray<{ output?: unknown; toolName?: string }> }>): string =>
    buildGoalTranscript(
        steps.flatMap((step) => [
            { message: { content: step.text ?? "", role: "assistant" } },
            ...(step.toolResults?.length
                ? [
                      {
                          message: {
                              content: step.toolResults.map((part) => {
                                  return { ...part, type: "tool-result" };
                              }),
                              role: "tool",
                          },
                      },
                  ]
                : []),
        ]),
    );
