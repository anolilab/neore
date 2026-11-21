import { describe, expect, it } from "vitest";

import { SAFE_SYSTEM_CONTEXT } from "../../vault/site-login-turn";
import { agentPromptKinds, type AgentPromptPieces, type SystemContextPieces, systemContextKinds } from "./system-context-kinds";

const none: SystemContextPieces = {
    bot: null,
    knowledge: false,
    memories: false,
    personalization: false,
    personalizationByImpersonator: false,
    project: false,
    systemPrompt: undefined,
    threadLanguage: false,
};

const safe = (kinds: ReadonlyArray<string>): boolean => kinds.every((kind) => SAFE_SYSTEM_CONTEXT.has(kind));

describe(systemContextKinds, () => {
    it("names the app's instructions, the owner's personalization and the teammate's instructions as the safe kinds", () => {
        const kinds = systemContextKinds({ ...none, bot: { instructionsByImpersonator: false }, personalization: true });

        expect(kinds).toStrictEqual(["instructions", "personalization", "teammate"]);
        expect(safe(kinds)).toBe(true);
    });

    it("gives personalization an admin wrote while acting as the owner a kind the verdict refuses, set or blanked since", () => {
        for (const personalization of [true, false]) {
            const kinds = systemContextKinds({ ...none, personalization, personalizationByImpersonator: true });

            expect(kinds).toContain("personalization-impersonated");
            expect(safe(kinds)).toBe(false);
        }
    });

    it("gives a teammate whose instructions an admin wrote a kind the verdict refuses", () => {
        const kinds = systemContextKinds({ ...none, bot: { instructionsByImpersonator: true } });

        expect(kinds).toContain("teammate-impersonated");
        expect(safe(kinds)).toBe(false);
    });

    it("names every other piece, and none of them is safe", () => {
        for (const pieces of [
            { memories: true },
            { knowledge: true },
            { project: true },
            { threadLanguage: true },
            { systemPrompt: "thread" as const },
            { systemPrompt: "request" as const },
        ]) {
            expect(safe(systemContextKinds({ ...none, ...pieces }))).toBe(false);
        }
    });
});

const noAgentPieces: AgentPromptPieces = {
    enabledSkills: false,
    fileNote: false,
    hasAgentMode: false,
    hasSearchMode: false,
    skillInstructions: false,
    taskPlan: false,
};

describe(agentPromptKinds, () => {
    it("names our own mode text and the task plan as safe kinds", () => {
        const kinds = agentPromptKinds({ ...noAgentPieces, hasAgentMode: true, hasSearchMode: true, taskPlan: true });

        expect(kinds).toStrictEqual(["agent-mode", "search-mode", "task-plan"]);
        expect(safe(kinds)).toBe(true);
    });

    it("gives skills, an invoked skill's instructions and the attached-documents note kinds the verdict refuses", () => {
        for (const pieces of [{ enabledSkills: true }, { skillInstructions: true }, { fileNote: true }]) {
            const kinds = agentPromptKinds({ ...noAgentPieces, ...pieces });

            expect(kinds).toHaveLength(1);
            expect(safe(kinds)).toBe(false);
        }
    });
});
