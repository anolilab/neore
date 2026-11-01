import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { leafRowOf } from "../../agent/agent-switch";
import { agentSwitchOf } from "../../agent/agent-switch-logic";
import { walkPath } from "../../agent/branch-rows";

/**
 * The most a handoff to a coding agent may weigh, in UTF-8 bytes as the signed call carries it. The call's whole input
 * is capped at 32 KiB (`MAX_DEVICE_INPUT_BYTES`) and holds the user's prompt as well, so the handoff takes about a third.
 */
export const HOST_HANDOFF_MAX_BYTES = 12 * 1024;

/** Rows looked at: a divider is followed by the prompt it waits for, so past a turn's few rows there is nothing to find. */
const SCAN_ROWS = 20;

/**
 * The handoff a coding agent has not been sent yet: the newest divider on the thread's path that carries one, when no
 * prompt of the user's follows it. The first prompt after a switch carries it (`/hosts/send`), and it is the prompt
 * row that ends the wait, so a later prompt, and a retry once the first was saved, send none.
 *
 * Derived from the path rather than flagged on the session, so a switch back to a branch that had its handoff sent
 * does not send it again. A prompt typed into the computer's own window is a prompt too: it did not carry the handoff,
 * and the thread does not wait for one any more.
 */
export const pendingHandoffOf = async (ctx: QueryCtx, thread: Doc<"threads">): Promise<string | undefined> => {
    const leaf = await leafRowOf(ctx, thread);

    if (!leaf) {
        return undefined;
    }

    const { rows } = await walkPath(ctx, thread._id, leaf, { limit: SCAN_ROWS });

    for (const row of rows) {
        const part = agentSwitchOf(row);

        // A `native` divider stores the handoff for a reattach that fails; until then the agent has its own session, and
        // no earlier divider's handoff is for it. What it lacks is what happened while it was away (`catchUp`).
        if (part?.mode === "native") {
            return part.catchUp;
        }

        if (part?.handoff) {
            return part.handoff;
        }

        if ((row.message as { role?: string } | undefined)?.role === "user") {
            return undefined;
        }
    }

    return undefined;
};

/**
 * Whether the thread is waiting for a coding agent to say if it loaded the saved session the newest divider asked for.
 * Until it does, nobody knows whether the first prompt must carry the handoff, and a prompt sent now would be saved
 * (ending the wait for one) before the answer: so none is taken (`/hosts/send`).
 */
export const awaitingReattach = async (ctx: QueryCtx, thread: Doc<"threads">): Promise<boolean> => {
    const leaf = await leafRowOf(ctx, thread);

    if (!leaf) {
        return false;
    }

    const { rows } = await walkPath(ctx, thread._id, leaf, { limit: SCAN_ROWS });

    for (const row of rows) {
        const part = agentSwitchOf(row);

        if (part) {
            return part.mode === "native";
        }

        if ((row.message as { role?: string } | undefined)?.role === "user") {
            return false;
        }
    }

    return false;
};
