/**
 * The error text a failed task round persists, which its owner reads on the
 * Tasks page. Kept apart from `execute.ts` so it is testable without loading
 * the action.
 */
import { parseCustomModelId } from "@neore/ai/models";

import { isAgentRunError } from "../chat/lib/agent-run";
import { toUserFacingError } from "../chat/lib/user-facing-error";

/**
 * A failure the runner raised itself, worded for the user (skill unusable, model
 * withdrawn, account being deleted, empty answer). Its message is shown as-is.
 */
export class TaskRunError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "TaskRunError";
    }
}

/** A round refused because its owner left the task's organization: it fails the same way every time, so the task stops recurring. */
export const stopsRecurrence = (error: unknown): boolean => isAgentRunError(error, "left-organization");

/**
 * What the task shows as its error. Our own {@link TaskRunError} and the run's
 * own refusal for a task whose owner left its organization pass through;
 * anything else — provider, gateway or runtime — goes through the shared mapper,
 * which never echoes raw text (it can carry internal URLs and upstream
 * payloads). The raw error is logged by the caller.
 */
export const taskErrorMessage = (error: unknown, model: string | undefined): string => {
    if (error instanceof TaskRunError || isAgentRunError(error, "left-organization")) {
        return error.message;
    }

    return toUserFacingError(error, { customEndpoint: model !== undefined && parseCustomModelId(model) !== null });
};
