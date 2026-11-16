import { stripHiddenText } from "@neore/ai/utils";

/**
 * The text the agent is given for a prompt: its hidden characters removed. `undefined` when only hidden characters were
 * sent, which is refused. The headless run and the trigger run log both use this rule, so the log and the agent cannot disagree.
 */
export const agentPromptText = (input: string): string | undefined => {
    const stripped = stripHiddenText(input);

    return stripped.removed > 0 && stripped.text.trim() === "" ? undefined : stripped.text;
};
