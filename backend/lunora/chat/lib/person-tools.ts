/**
 * Built-ins that exist to wait for a person — `askUser` and `requestSecret` pause the run until
 * the user answers, whatever their mode (the tools themselves always need approval).
 * A headless run has nobody to answer, so they are removed there even when the
 * user set them to `auto`. `mergePullRequest` is here for the same reason: a merge is approved by a person every time, so
 * a run nobody is at never has it, and no time-boxed allow covers it. So is `signInWithSavedLogin`: the person approves
 * every sign-in with a saved login.
 */
export const BUILTIN_TOOLS_NEEDING_A_PERSON: ReadonlySet<string> = new Set(["askUser", "mergePullRequest", "requestSecret", "signInWithSavedLogin"]);

/**
 * Built-ins a run nobody is at never has, though a person may still allow them for an hour or a day: `remember` saves and
 * `forget` deletes only on a request the user typed in the message they just sent, which a run nobody is at has none of.
 */
export const BUILTIN_TOOLS_NOT_HEADLESS: ReadonlySet<string> = new Set(["forget", "remember"]);
