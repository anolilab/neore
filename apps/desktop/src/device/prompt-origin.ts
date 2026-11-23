/**
 * Who asked for a call, as its prompt says it. The two global-instruction tools are started by the person's own click in
 * a project's settings, never by the agent (`device-core/src/global_instructions.rs`), so their prompt says so and
 * shows no thread title: a chat could give its thread any title.
 */
const SETTINGS_TOOLS: ReadonlySet<string> = new Set(["instructions_list", "instructions_read"]);

export const isSettingsRequest = (tool: string): boolean => SETTINGS_TOOLS.has(tool);

/** The prompt's line about where the call came from. */
export const promptOrigin = (tool: string, threadTitle: string): string => {
    if (isSettingsRequest(tool)) {
        return "Requested from a project's settings in Neore, not by the agent.";
    }

    return threadTitle ? `Requested by the agent in “${threadTitle}”.` : "Requested by the agent.";
};

/** The heading of a call's prompt. */
export const promptHeading = (tool: string, host: string | undefined): string => {
    if (tool === "instructions_list") {
        return "Check for global instruction files?";
    }

    if (tool === "instructions_read") {
        return "Send global instruction files to Neore?";
    }

    return host === undefined ? `Allow “${tool}”?` : `Allow “${tool}” on ${host}?`;
};
