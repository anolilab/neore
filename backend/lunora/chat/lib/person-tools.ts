/**
 * Built-ins that exist to wait for a person — `askUser` and `requestSecret` pause the run until
 * the user answers, whatever their mode (the tools themselves always need approval).
 * A headless run has nobody to answer, so they are removed there even when the
 * user set them to `auto`.
 */
export const BUILTIN_TOOLS_NEEDING_A_PERSON: ReadonlySet<string> = new Set(["askUser", "requestSecret"]);
