/**
 * The wrap-up a reply gets when it spends its step cap on a tool step, so no answer text was written (`execute.ts`).
 *
 * The cap is `stepCountIs(maxSteps)` (`persist-stream.ts`). The step that reaches it is a tool step, and the loop stops
 * before the model answers. The run then makes one more call with tools off and {@link CAP_WRAP_UP_INSTRUCTION}. That
 * call has no tools, so it ends after its one step and cannot reach the cap again: one wrap-up per run.
 */

/**
 * Appended to the run's system prompt for the wrap-up call. It asks for the outcome (what was done, what remains), not a
 * step-by-step transcript, and it says plainly that no tool is available.
 */
export const CAP_WRAP_UP_INSTRUCTION =
    "This reply has used all of its tool steps, and you cannot call any tool now. Reply in plain text: in a few sentences, " +
    "summarise what you did and what is still left to do, so the person knows where things stand.";

/**
 * Whether the run ended on its step cap with no answer. `finishReason` is the last step's: a tool step (`tool-calls`) that
 * the cap stopped, after `maxSteps` steps of this invocation. A run that ended for another reason (a stop, a loop the guard
 * ended, a pause on an approval) is not capped, and a run that answered in text is not either.
 */
export const endedOnStepCap = (args: { finishReason: string | undefined; maxSteps: number; stepsRun: number }): boolean =>
    args.finishReason === "tool-calls" && args.stepsRun >= args.maxSteps;
