export type PromptSeedState = "current" | "reseed" | "stale-edits";

/**
 * Decides what the optimizer dialog does when the saved prompt it was seeded from (`seed`) may have
 * moved on to `initialPrompt` while the user was editing `prompt`.
 */
export const resolvePromptSeed = ({ initialPrompt, prompt, seed }: { initialPrompt: string; prompt: string; seed: string }): PromptSeedState => {
    if (seed === initialPrompt || prompt === initialPrompt) {
        return "current";
    }

    return prompt === seed ? "reseed" : "stale-edits";
};
