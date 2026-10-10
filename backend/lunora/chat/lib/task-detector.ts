/**
 * @deprecated Use the unified classification from the LLM Gateway's
 * `/internal/route` endpoint (classification.taskType, classification.isComplex, etc.) instead.
 * This file is kept for backward compatibility during the migration.
 * See: services/llm-gateway/src/routing/classify.ts
 */
import type { TaskType } from "@neore/ai/prompts";

const WHITESPACE_RE = /\s+/;

/**
 * Task analysis result from complexity detection
 */
export interface TaskAnalysis {
    /** Confidence score (0-1) in the detection */
    confidence: number;
    /** Whether the task is complex enough to need enhanced modules */
    isComplex: boolean;
    /** Whether the task requires planning/breaking down */
    requiresPlanning: boolean;
    /** Whether the task requires validation/testing */
    requiresValidation: boolean;
    /** The detected task type */
    taskType: TaskType;
}

/**
 * Keywords that indicate task complexity levels
 */
const COMPLEXITY_INDICATORS = {
    high: [
        "build",
        "create a system",
        "implement",
        "migrate",
        "refactor",
        "analyze and",
        "research and",
        "step by step",
        "comprehensive",
        "develop",
        "design",
        "architect",
        "integrate",
    ],
    planning: ["plan", "step", "phases", "roadmap", "strategy", "outline", "organize", "structure"],
    validation: ["validate", "test", "verify", "check", "ensure", "confirm", "audit"],
};

/**
 * Keywords that indicate specific task types
 */
const TASK_TYPE_KEYWORDS = {
    coding: ["code", "implement", "build", "develop", "debug", "fix bug", "write function", "create api", "refactor", "optimize code", "programming"],
    "data-analysis": ["analyze data", "statistics", "metrics", "calculate", "compute", "visualization", "graph", "chart", "dataset", "sql"],
    research: [
        "research",
        "find information",
        "investigate",
        "explore",
        "gather data",
        "look up",
        "search for",
        "what is",
        "who is",
        "tell me about",
        "explain",
    ],
    writing: ["write", "draft", "compose", "document", "blog post", "article", "documentation", "copy", "content"],
};

/**
 * Detects task complexity and type from user message.
 * @param userMessage The user's message/prompt
 * @returns Task analysis with complexity indicators
 */
const detectTaskComplexity = (userMessage: string): TaskAnalysis => {
    // Handle empty/whitespace-only messages
    if (!userMessage || userMessage.trim().length === 0) {
        return {
            confidence: 1,
            isComplex: false,
            requiresPlanning: false,
            requiresValidation: false,
            taskType: "general",
        };
    }

    const lowerMessage = userMessage.toLowerCase();
    const wordCount = userMessage.split(WHITESPACE_RE).length;

    // Short questions are usually not complex
    if (wordCount < 5 && lowerMessage.includes("?")) {
        return {
            confidence: 0.9,
            isComplex: false,
            requiresPlanning: false,
            requiresValidation: false,
            taskType: "general",
        };
    }

    // Detect task type
    let taskType: TaskType = "general";
    let maxTypeScore = 0;

    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
        const matches = keywords.filter((keyword) => lowerMessage.includes(keyword.toLowerCase())).length;
        const score = matches / keywords.length;

        if (score > maxTypeScore) {
            maxTypeScore = score;
            taskType = type as TaskType;
        }
    }

    // Detect complexity indicators
    const hasHighComplexityIndicators = COMPLEXITY_INDICATORS.high.some((keyword) => lowerMessage.includes(keyword.toLowerCase()));

    const hasPlanningIndicators = COMPLEXITY_INDICATORS.planning.some((keyword) => lowerMessage.includes(keyword.toLowerCase()));

    const hasValidationIndicators = COMPLEXITY_INDICATORS.validation.some((keyword) => lowerMessage.includes(keyword.toLowerCase()));

    // Complexity scoring
    let complexityScore = 0;

    // Long messages are more likely to be complex
    if (wordCount > 15) {
        complexityScore += 0.3;
    }

    // Explicit complexity indicators
    if (hasHighComplexityIndicators) {
        complexityScore += 0.4;
    }

    // Planning/validation needs add complexity
    if (hasPlanningIndicators) {
        complexityScore += 0.2;
    }

    if (hasValidationIndicators) {
        complexityScore += 0.1;
    }

    // Task type contributes to complexity
    if (taskType === "coding" || taskType === "data-analysis") {
        complexityScore += 0.2;
    } else if (taskType === "research") {
        complexityScore += 0.15;
    }

    // Determine if task is complex (threshold: 0.5)
    const isComplex = complexityScore >= 0.5;

    // Determine planning requirement
    const requiresPlanning = hasPlanningIndicators || (isComplex && (taskType === "coding" || taskType === "data-analysis"));

    // Determine validation requirement
    const requiresValidation = hasValidationIndicators || (isComplex && taskType === "coding");

    // Calculate confidence based on how clear the signals are
    let confidence = 0.6; // Base confidence

    if (maxTypeScore > 0.3) {
        confidence += 0.2; // Strong task type signal
    }

    if (hasHighComplexityIndicators) {
        confidence += 0.2; // Explicit complexity indicators
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1);

    return {
        confidence,
        isComplex,
        requiresPlanning,
        requiresValidation,
        taskType,
    };
};

export default detectTaskComplexity;
