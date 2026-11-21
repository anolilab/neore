/**
 * One kind per piece `loadRunContext` puts on a run's system prompt, for the saved-login verdict
 * (`vault/site-login-turn.ts#SAFE_SYSTEM_CONTEXT`, an allowlist). Text an admin wrote while acting as the owner gets a
 * kind of its own (`…-impersonated`), which that list never holds, so the verdict refuses it by name. What `getAgent`
 * adds later (enabled skills, the agent and search modes) is not named here: whoever builds a login turn from these
 * kinds adds those too, a skill with a kind that refuses.
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
