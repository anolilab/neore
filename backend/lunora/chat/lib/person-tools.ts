/**
 * Built-ins that exist to wait for a person — `askUser` pauses the run until
 * the user answers, whatever its mode (the tool itself always needs approval).
 * A headless run has nobody to answer, so they are removed there even when the
 * user set them to `auto`.
 */
export const BUILTIN_TOOLS_NEEDING_A_PERSON: ReadonlySet<string> = new Set(["askUser"]);
