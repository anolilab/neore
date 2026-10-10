/**
 * Query scoring engine.
 *
 * Fast heuristic scoring (&lt;2ms target) using regex, keyword matching,
 * and structural analysis. No LLM calls — all local computation.
 */
import type { ModelMessage } from "ai";

import type { QueryScore } from "./dimensions.js";

/**
 * Regex patterns for complexity detection. Code and math each use two patterns
 * — a keyword alternation plus a symbol/markup pattern — so neither literal
 * exceeds the regex complexity budget; both halves are always tested together.
 */
const CODE_KEYWORDS = /\b(?:function|class|import|export|const|let|var|def|async|await|return|interface|type|struct|enum|impl|fn|pub|mod|crate)\b/i;
const CODE_MARKUP = /```|<code>/i;
const MATH_KEYWORDS = /\b(?:solve|equation|integral|derivative|proof|theorem|calculate|compute|formula|sum|product|limit|converge)\b/i;
// `\d` rather than `\d+`: for an unanchored existence test the two are
// equivalent, and `\d+` backtracks quadratically on long digit runs.
const MATH_SYMBOLS = /\d[+\-*/^]=?|\\frac|\\sqrt|[∑∏∫]/i;
const REASONING_PATTERNS =
    /\b(?:step[- ]by[- ]step|analyze|explain why|compare|evaluate|trade[- ]?off|pros? and cons?|reasoning|logic|deduce|infer|conclude)\b/i;
const CREATIVE_PATTERNS = /\b(?:write|story|poem|creative|imagine|fiction|essay|narrative|compose|draft|brainstorm)\b/i;
const SIMPLE_PATTERNS = /^(?:hi|hello|hey|thanks|thank you|ok|yes|no|sure|bye|goodbye|what is|who is|when|where)\b/i;

const hasCodePattern = (text: string): boolean => CODE_KEYWORDS.test(text) || CODE_MARKUP.test(text);
const hasMathPattern = (text: string): boolean => MATH_KEYWORDS.test(text) || MATH_SYMBOLS.test(text);

/** Weights for combining dimension scores into a single combined score */
const WEIGHTS = {
    codeGeneration: 0.15,
    complexity: 0.25,
    contextLength: 0.1,
    creativity: 0.05,
    multimodal: 0.05,
    reasoning: 0.2,
    technicalDomain: 0.1,
    toolUse: 0.1,
};

/**
 * Roles excluded from routing-score text. System/developer messages contain
 * agent prompts, memory context, and tool descriptions that don't reflect the
 * user's intent and would otherwise inflate the combined score toward Complex
 * tier on every request.
 */
const SCORING_EXCLUDED_ROLES = new Set(["developer", "system"]);

/**
 * Recency window for scoring. Long threads accumulate context that no longer
 * reflects the latest turn — only the last N user/assistant/tool messages are
 * scored to keep routing decisions responsive to the current intent.
 */
const SCORING_RECENT_MESSAGES = 10;

const isScoringRelevant = (m: ModelMessage): boolean => !SCORING_EXCLUDED_ROLES.has(m.role);

/** Returns the slice of messages used for scoring (filtered + recency-windowed). */
const getScoringMessages = (messages: ModelMessage[]): ModelMessage[] => messages.filter((m) => isScoringRelevant(m)).slice(-SCORING_RECENT_MESSAGES);

export const scoreQuery = (request: {
    messages: ModelMessage[];
    preferredQuality?: number;
    /** Number of distinct tools offered with the request — only the count feeds scoring. */
    toolCount?: number;
    userTier: string;
}): QueryScore => {
    const scoringMessages = getScoringMessages(request.messages);
    const lastUserMessage = getLastUserMessage(scoringMessages);
    const allText = getAllText(scoringMessages);
    const estimatedTokens = allText.length / 4;
    const toolCount = request.toolCount ?? 0;

    // Score each dimension
    const complexity = scoreComplexity(lastUserMessage, allText);
    const codeGeneration = scoreCodeGeneration(lastUserMessage, allText);
    const creativity = scoreCreativity(lastUserMessage);
    const reasoning = scoreReasoning(lastUserMessage, allText);
    const contextLength = Math.min(estimatedTokens / 32_000, 1); // Normalize to 32k
    const multimodal = hasMultimodalContent(scoringMessages) ? 1 : 0;
    const toolUse = toolCount > 0 ? Math.min(toolCount / 20, 1) : 0;
    const technicalDomain = scoreTechnicalDomain(lastUserMessage);
    const preferredQuality = request.preferredQuality ?? 0.5;
    const language = detectLanguage(lastUserMessage);

    // Combined weighted score
    const combined = Math.min(
        1,
        complexity * WEIGHTS.complexity +
            codeGeneration * WEIGHTS.codeGeneration +
            creativity * WEIGHTS.creativity +
            reasoning * WEIGHTS.reasoning +
            contextLength * WEIGHTS.contextLength +
            multimodal * WEIGHTS.multimodal +
            toolUse * WEIGHTS.toolUse +
            technicalDomain * WEIGHTS.technicalDomain,
    );

    return {
        codeGeneration,
        combined,
        complexity,
        contextLength,
        creativity,
        language,
        multimodal,
        preferredQuality,
        reasoning,
        technicalDomain,
        toolUse,
        userTier: request.userTier,
    };
};

const getLastUserMessage = (messages: ModelMessage[]): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;

        if (message.role === "user") {
            if (typeof message.content === "string") return message.content;

            if (Array.isArray(message.content)) {
                return message.content
                    .filter((p: { type: string }) => p.type === "text")
                    .map((p: { text?: string; type: string }) => p.text ?? "")
                    .join(" ");
            }
        }
    }

    return "";
};

const getAllText = (messages: ModelMessage[]): string =>
    messages
        .map((m) => {
            if (typeof m.content === "string") return m.content;

            if (Array.isArray(m.content)) {
                return m.content
                    .filter((p: { type: string }) => p.type === "text")
                    .map((p: { text?: string; type: string }) => p.text ?? "")
                    .join(" ");
            }

            return "";
        })
        .join("\n");

const scoreComplexity = (lastMessage: string, allText: string): number => {
    if (SIMPLE_PATTERNS.test(lastMessage) && lastMessage.length < 50) return 0.1;

    let score = 0.3; // Baseline for non-trivial queries

    if (lastMessage.length > 500) score += 0.2;

    if (lastMessage.length > 2000) score += 0.2;

    if (allText.length > 10_000) score += 0.1;

    if ((lastMessage.match(/\n/g)?.length ?? 0) > 5) score += 0.1;

    return Math.min(score, 1);
};

const scoreCodeGeneration = (lastMessage: string, allText: string): number => {
    let score = 0;

    if (hasCodePattern(lastMessage)) score += 0.5;

    if (hasCodePattern(allText)) score += 0.2;

    if (lastMessage.includes("```")) score += 0.3;

    return Math.min(score, 1);
};

const scoreCreativity = (lastMessage: string): number => (CREATIVE_PATTERNS.test(lastMessage) ? 0.7 : 0.1);

const scoreReasoning = (lastMessage: string, allText: string): number => {
    let score = 0;

    if (hasMathPattern(lastMessage)) score += 0.5;

    if (REASONING_PATTERNS.test(lastMessage)) score += 0.4;

    if (hasMathPattern(allText)) score += 0.1;

    return Math.min(score, 1);
};

const hasMultimodalContent = (messages: ModelMessage[]): boolean =>
    messages.some((m) => Array.isArray(m.content) && m.content.some((p: { type: string }) => p.type === "image" || p.type === "file"));

const scoreTechnicalDomain = (lastMessage: string): number => {
    const techTerms =
        /\b(api|sdk|middleware|database|query|mutation|schema|deployment|kubernetes|docker|terraform|ci\/cd|microservice|endpoint|webhook|jwt|oauth|graphql|rest|grpc)\b/gi;
    const matches = lastMessage.match(techTerms);

    if (!matches) return 0.1;

    return Math.min(matches.length * 0.15, 1);
};

/** Character ranges used for simple script-based language detection. */
const HAN_RANGE = /[\u{4E00}-\u{9FFF}]/u;
const KANA_RANGE = /[\u{3040}-\u{309F}\u{30A0}-\u{30FF}]/u;
const HANGUL_RANGE = /[\u{AC00}-\u{D7AF}]/u;
const ARABIC_RANGE = /[\u{600}-\u{6FF}]/u;
const CYRILLIC_RANGE = /[\u{400}-\u{4FF}]/u;

/** Detects the dominant script of a text and maps it to a language code. */
const detectLanguage = (text: string): string => {
    if (HAN_RANGE.test(text)) return "zh";

    if (KANA_RANGE.test(text)) return "ja";

    if (HANGUL_RANGE.test(text)) return "ko";

    if (ARABIC_RANGE.test(text)) return "ar";

    if (CYRILLIC_RANGE.test(text)) return "ru";

    return "en";
};
