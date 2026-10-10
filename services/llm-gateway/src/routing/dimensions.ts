/**
 * Query scoring dimensions for smart routing.
 *
 * Each dimension is scored 0-1 based on heuristics applied to the request.
 */

export interface QueryScore {
    /** 0-1: presence of code-related keywords/context */
    codeGeneration: number;
    /** Combined weighted score */
    combined: number;
    /** 0-1: simple greeting vs. multi-step reasoning */
    complexity: number;
    /** 0-1: normalized input token count */
    contextLength: number;
    /** 0-1: creative writing vs. factual Q&amp;A */
    creativity: number;
    /** ISO code, affects model selection */
    language: string;
    /** 0-1: has images/files */
    multimodal: number;
    /** 0-1: user's quality vs. speed preference */
    preferredQuality: number;
    /** 0-1: math, logic, step-by-step analysis */
    reasoning: number;
    /** 0-1: domain-specific terminology density */
    technicalDomain: number;
    /** 0-1: tools available, likelihood of use */
    toolUse: number;
    /** free/pro/enterprise -> model pool filter */
    userTier: string;
}
