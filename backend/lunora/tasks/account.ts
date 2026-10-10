/**
 * Who may make tasks run, and what each round costs them.
 *
 * A task round is a full headless agent run plus a verifier call, started with
 * nobody watching — so it answers to the same limits as a chat message and some
 * of its own:
 *
 * - An anonymous account cannot own or run tasks. Chat pins anonymous users to a
 *   free model; a task names its own, so the only safe answer is no.
 * - Every round is charged to the chat daily message limit (`chat/dailyText`)
 *   AND to a tasks-only daily ceiling (`tasks/dailyRuns`), so a recurring task
 *   can neither bypass the first nor spend all of it.
 * - Admins are exempt, as they are in chat.
 *
 * The account is read from the `user` row, not the session: rounds run from the
 * scheduler, where there is no session, and `SessionUser` does not carry
 * `isAnonymous` anyway.
 */
import { LunoraError } from "lunorash/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getUser } from "../auth/lib/better-auth-queries";
import { createRatelimit, getUserTier } from "../lib/rate-limiter";

export interface TaskAccount {
    isAdmin: boolean;
    isAnonymous: boolean;
    tier: "free" | "premium";
}

export const ANONYMOUS_TASKS_MESSAGE = "Tasks need an account. Sign up to create and run tasks.";

/** The account behind `userId`, or `null` when the user no longer exists. */
export const loadTaskAccount = async (ctx: QueryCtx, userId: string): Promise<TaskAccount | null> => {
    const user = await getUser(ctx, userId);

    if (!user) {
        return null;
    }

    return {
        isAdmin: user.role === "admin",
        isAnonymous: user.isAnonymous === true,
        tier: getUserTier({ plan: (user as { plan?: "premium" | null }).plan }) === "premium" ? "premium" : "free",
    };
};

/** Why `account` may not use tasks, or `undefined` when it may. */
export const taskAccessProblem = (account: TaskAccount | null): string | undefined => {
    if (!account) {
        return "Your account no longer exists.";
    }

    return account.isAnonymous ? ANONYMOUS_TASKS_MESSAGE : undefined;
};

/** For the public procedures that create or start a task: FORBIDDEN for an anonymous account. */
export const requireTaskAccount = async (ctx: QueryCtx, userId: string): Promise<TaskAccount> => {
    const account = await loadTaskAccount(ctx, userId);
    const problem = taskAccessProblem(account);

    if (problem || !account) {
        throw new LunoraError("FORBIDDEN", problem ?? ANONYMOUS_TASKS_MESSAGE);
    }

    return account;
};

/** The daily limits one round is charged against, in the order they are reported. */
export const roundQuotaKeys = (account: TaskAccount): string[] =>
    account.isAdmin ? [] : [`chat/dailyText:${account.tier}`, `tasks/dailyRuns:${account.tier}`];

export const DAILY_LIMIT_MESSAGE = "You've reached your daily limit for task runs. Run the task again tomorrow.";

/** Whether every daily limit still has room for one round — a read, nothing is consumed. */
export const hasRoundAllowance = async (ctx: MutationCtx, userId: string, account: TaskAccount): Promise<boolean> => {
    for (const key of roundQuotaKeys(account)) {
        const { remaining } = await createRatelimit(key, ctx.db as never).getRemaining(userId);

        if (remaining < 1) {
            return false;
        }
    }

    return true;
};

/**
 * Charges one round to every daily limit, or none: all are checked before any is
 * consumed, so a round refused by one limit does not spend the others. Returns
 * `false` when a limit is exhausted.
 */
export const chargeRound = async (ctx: MutationCtx, userId: string, account: TaskAccount): Promise<boolean> => {
    if (!(await hasRoundAllowance(ctx, userId, account))) {
        return false;
    }

    const limiters = roundQuotaKeys(account).map((key) => createRatelimit(key, ctx.db as never));

    for (const limiter of limiters) {
        const { ok } = await limiter.limit(userId);

        if (!ok) {
            return false;
        }
    }

    return true;
};
