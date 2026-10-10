import type { StepResult, StopCondition } from "ai";

import type { Id, TableName } from "../../_generated/dataModel";

/**
 * Helper to cast a string ID to an Id type.
 * Used when passing IDs from the public API (which uses strings) to internal functions.
 */
export const asId = <T extends TableName>(id: string): Id<T> => id as Id<T>;

/**
 * Helper to cast an optional string ID to an optional Id type.
 */
export const asOptionalId = <T extends TableName>(id: string | undefined): Id<T> | undefined => id as Id<T> | undefined;

/**
 * Helper to cast an array of string IDs to an array of Id types.
 */
export const asIdArray = <T extends TableName>(ids: string[]): Id<T>[] => ids as Id<T>[];

/**
 * Helper to cast an optional array of string IDs to an optional array of Id types.
 */
export const asOptionalIdArray = <T extends TableName>(ids: string[] | undefined): Id<T>[] | undefined => ids as Id<T>[] | undefined;

export const willContinue = async (
    steps: StepResult<any>[],

    stopWhen: StopCondition<any> | StopCondition<any>[] | undefined,
): Promise<boolean> => {
    const step = steps.at(-1)!;

    // we aren't doing another round after a tool result
    // TODO: whether to handle continuing after too much context used..
    if (step.finishReason !== "tool-calls") {
        return false;
    }

    // we don't have a tool result, so we'll wait for more
    if (step.toolCalls.length > step.toolResults.length) {
        return false;
    }

    // If any tool result has an error, continue without evaluating stopWhen.
    // This allows the LLM to retry or handle the error.
    const hasErrorResult = step.toolResults.some((result) => (result as { isError?: boolean }).isError === true);

    if (hasErrorResult) {
        return true;
    }

    if (Array.isArray(stopWhen)) {
        const stops = await Promise.all(stopWhen.map(async (s) => s({ steps })));

        return stops.every((stop) => !stop);
    }

    return !!stopWhen && !(await stopWhen({ steps }));
};

export const errorToString = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
};
