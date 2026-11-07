/**
 * Built-ins that exist to wait for a person — `askUser` and `requestSecret` pause the run until
 * the user answers, whatever their mode (the tools themselves always need approval).
 * A headless run has nobody to answer, so they are removed there even when the
 * user set them to `auto`. `mergePullRequest` is here for the same reason: a merge is approved by a person every time, so
 * a run nobody is at never has it, and no time-boxed allow covers it.
 */
export const BUILTIN_TOOLS_NEEDING_A_PERSON: ReadonlySet<string> = new Set(["askUser", "mergePullRequest", "requestSecret"]);
