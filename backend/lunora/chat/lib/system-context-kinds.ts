/**
 * One kind per piece `loadRunContext` puts on a run's system prompt, for the saved-login verdict
 * (`vault/site-login-turn.ts#SAFE_SYSTEM_CONTEXT`, an allowlist). Text an admin wrote while acting as the owner gets a
 * kind of its own (`…-impersonated`), which that list never holds, so the verdict refuses it by name. What `getAgent`
 * adds later (enabled skills, the agent and search modes) is named by {@link agentPromptKinds}; the run sets both on
 * its tool context (`setRunTurn`) and in a pause's snapshot.
 */
export type SystemContextPieces = {
    bot: { instructionsByImpersonator: boolean } | null;
    knowledge: boolean;
    memories: boolean;
    personalization: boolean;
    personalizationByImpersonator: boolean;
    project: boolean;
    /** The request's own instructions, or the thread's stored ones (which win). */
    systemPrompt: "request" | "thread" | undefined;
    /** The thread's own response language, free text anyone with write access to the thread may set. */
    threadLanguage: boolean;
};

export const systemContextKinds = (pieces: SystemContextPieces): string[] => {
    const kinds = ["instructions"];

    // Marked rows count whatever is left of them: a field an admin wrote may be blank now while another they wrote is not.
    if (pieces.personalizationByImpersonator) {
        kinds.push("personalization-impersonated");
    } else if (pieces.personalization) {
        kinds.push("personalization");
    }

    if (pieces.memories) {
        kinds.push("memories");
    }

    if (pieces.knowledge) {
        kinds.push("knowledge");
    }

    if (pieces.project) {
        kinds.push("project");
    }

    if (pieces.bot) {
        kinds.push(pieces.bot.instructionsByImpersonator ? "teammate-impersonated" : "teammate");
    }

    if (pieces.threadLanguage) {
        kinds.push("thread-language");
    }

    if (pieces.systemPrompt) {
        kinds.push(`${pieces.systemPrompt}-instructions`);
    }

    return kinds;
};

/** What `getAgent` (`get-agent.ts`) and the run around it add to the system prompt, beyond the context above. */
export type AgentPromptPieces = {
    /** Enabled skills: their names and descriptions, which their authors wrote (Level 1). */
    enabledSkills: boolean;
    /** A note that the prompt carries attached documents (`execute.ts`). */
    fileNote: boolean;
    /** The planner, knowledge and datasource modules (`AgentModeConfig`): our own text, no stored input. */
    hasAgentMode: boolean;
    /** The search mode's citation rules: our own text, chosen from a fixed list. */
    hasSearchMode: boolean;
    /** An invoked skill's full instructions (Level 2). */
    skillInstructions: boolean;
    /** The complex-task prompt, which quotes the run's own prompt (`getComplexTaskPrompt`). */
    taskPlan: boolean;
};

/**
 * One kind per piece {@link AgentPromptPieces} names. Skill text refuses (`skills`, `skill-instructions`): its author may
 * be anyone the owner enabled it from, and no allowlist vouches for it. The modes are our own text; the task plan quotes
 * only the prompt, which the verdict checks as the owner's own typed row.
 */
export const agentPromptKinds = (pieces: AgentPromptPieces): string[] => [
    ...(pieces.hasAgentMode ? ["agent-mode"] : []),
    ...(pieces.hasSearchMode ? ["search-mode"] : []),
    ...(pieces.taskPlan ? ["task-plan"] : []),
    ...(pieces.enabledSkills ? ["skills"] : []),
    ...(pieces.skillInstructions ? ["skill-instructions"] : []),
    ...(pieces.fileNote ? ["attached-documents"] : []),
];
