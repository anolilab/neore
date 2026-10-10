/**
 * Unified query classification — combines search-mode recommendation
 * and task complexity detection into a single classification pass.
 *
 * Ported from the backend's `chat/lib/query-classifier.ts` and `chat/lib/task-detector.ts`.
 * Runs alongside the existing 23-dimension scoring engine.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchModeRecommendation = "chat" | "web" | "academic";

export type TaskType = "general" | "research" | "coding" | "data-analysis" | "writing";

export interface QueryClassification {
    confidence: number;
    isComplex: boolean;
    requiresPlanning: boolean;
    requiresValidation: boolean;
    searchMode: SearchModeRecommendation;
    taskType: TaskType;
}

// ── Search Mode Classification ───────────────────────────────────────────────

// Time-sensitive markers (subset — covers ~95% of user queries).
// Split English/non-English purely to keep each pattern below the regex
// complexity budget; the two are always tested together.
const TIME_SENSITIVE_EN = /\b(?:latest|newest|recent|current|today|yesterday|right now|breaking|this week|this month)\b/iu;
const TIME_SENSITIVE_INTL = /\b(?:aktuell|neueste|heute|gestern|último|reciente|hoy|ayer|dernier|récent|最新|最近|今天|昨天|최신|오늘)\b/iu;

// Weather (multilingual)
const WEATHER = /\b(?:weather|temperature|forecast|rain|snow|wetter|temperatur|clima|tiempo|météo|天气|날씨|погода)\b/iu;

// News
const NEWS = /\b(?:news|headlines|nachrichten|noticias|actualités|新闻|뉴스|новости)\b/iu;

// Price/market data
const MARKET = /\b(?:price|cost|stock|share|market cap|preis|kosten|aktie|precio|costo|prix|coût)\b/i;

// URLs
const URL_REF = /https?:\/\/|www\.|\.com|\.org|\.io|\.dev/i;

// Year references (seeking current info)
const RECENT_YEAR = /\b20(?:2[4-9]|[3-9]\d)\b/;

// Direct-answer: greetings (fast check)
const GREETING = /^(?:hi|hello|hey|howdy|thanks|thank you|bye|goodbye|hallo|hola|bonjour|ciao|olá|привет|你好|こんにちは|안녕하세요|مرحبا)\b/iu;

// Direct-answer: math
const MATH_EXPR = /^\d+\s*[+\-*/^%]\s*\d+/;

// Direct-answer: code generation/explanation. Composed from the two keyword
// lists so neither alternation blows the regex complexity budget.
const CODE_GEN_VERBS = ["write", "create", "make", "generate", "implement", "code", "explain", "define", "what(?:'?s| is| are)"];
const CODE_GEN_NOUNS = ["function", "method", "class", "script", "program", "component", "hook", "recursion", "polymorphism", "closure"];
const CODE_GEN = new RegExp(String.raw`^(?:${CODE_GEN_VERBS.join("|")})\s+(?:(?:a|an|the)\s+)?(?:\w+\s*)?(?:${CODE_GEN_NOUNS.join("|")})`, "i");

// Direct-answer: creative requests
const CREATIVE_REQ = /^(?:tell me a|write a|compose a)\s+(?:joke|story|poem|haiku|limerick|song)/i;

// Direct-answer: text transforms
const TEXT_TRANSFORM = /^(?:summarize|rephrase|rewrite|paraphrase|simplify|elaborate on|translate|convert)\s/i;

// Whitespace splitter for word counting
const WHITESPACE = /\s+/;

/**
 * Determines if a query needs web search or can be answered directly.
 */
const classifySearchMode = (text: string): { confidence: number; mode: SearchModeRecommendation } => {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
        return { confidence: 0.5, mode: "chat" };
    }

    // Direct-answer patterns (high confidence)
    if (GREETING.test(trimmed) || MATH_EXPR.test(trimmed) || CODE_GEN.test(trimmed) || CREATIVE_REQ.test(trimmed) || TEXT_TRANSFORM.test(trimmed)) {
        return { confidence: 0.95, mode: "chat" };
    }

    // Short simple messages
    const wordCount = trimmed.split(WHITESPACE).length;

    if (wordCount <= 2) {
        return { confidence: 0.85, mode: "chat" };
    }

    // Search-required patterns
    if (
        TIME_SENSITIVE_EN.test(trimmed) ||
        TIME_SENSITIVE_INTL.test(trimmed) ||
        WEATHER.test(trimmed) ||
        NEWS.test(trimmed) ||
        MARKET.test(trimmed) ||
        URL_REF.test(trimmed) ||
        RECENT_YEAR.test(trimmed)
    ) {
        return { confidence: 0.9, mode: "web" };
    }

    // Default: ambiguous — recommend chat (conservative, don't waste search API calls)
    return { confidence: 0.5, mode: "chat" };
};

// ── Task Complexity Detection ────────────────────────────────────────────────

const COMPLEXITY_HIGH =
    /\b(?:build|create a system|implement|migrate|refactor|analyze and|research and|step by step|comprehensive|develop|design|architect|integrate)\b/i;
const PLANNING_KEYWORDS = /\b(?:plan|phases|roadmap|strategy|outline|organize|structure)\b/i;
const VALIDATION_KEYWORDS = /\b(?:validate|test|verify|check|ensure|confirm|audit)\b/i;

const TASK_TYPE_PATTERNS: { pattern: RegExp; type: TaskType; weight: number }[] = [
    { pattern: /\b(research|investigate|explore|gather data|look up|search for|find information)\b/i, type: "research", weight: 1 },
    { pattern: /\b(code|implement|build|develop|debug|fix bug|write function|create api|refactor|optimize code|programming)\b/i, type: "coding", weight: 1 },
    { pattern: /\b(analyze data|statistics|metrics|calculate|compute|visualization|graph|chart|dataset|sql)\b/i, type: "data-analysis", weight: 1 },
    { pattern: /\b(write|draft|compose|document|blog post|article|documentation|copy|content)\b/i, type: "writing", weight: 0.8 },
];

const detectComplexity = (text: string): Omit<QueryClassification, "searchMode"> => {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
        return { confidence: 1, isComplex: false, requiresPlanning: false, requiresValidation: false, taskType: "general" };
    }

    const wordCount = trimmed.split(WHITESPACE).length;

    // Short questions are usually not complex
    if (wordCount < 5 && trimmed.includes("?")) {
        return { confidence: 0.9, isComplex: false, requiresPlanning: false, requiresValidation: false, taskType: "general" };
    }

    // Detect task type
    let taskType: TaskType = "general";
    let maxScore = 0;

    for (const { pattern, type, weight } of TASK_TYPE_PATTERNS) {
        const matches = trimmed.match(pattern);

        if (matches && weight > maxScore) {
            maxScore = weight;
            taskType = type;
        }
    }

    // Complexity scoring
    const hasHighComplexity = COMPLEXITY_HIGH.test(trimmed);
    const hasPlanning = PLANNING_KEYWORDS.test(trimmed);
    const hasValidation = VALIDATION_KEYWORDS.test(trimmed);

    let score = 0;

    if (wordCount > 15) score += 0.3;

    if (hasHighComplexity) score += 0.4;

    if (hasPlanning) score += 0.2;

    if (hasValidation) score += 0.1;

    if (taskType === "coding" || taskType === "data-analysis") score += 0.2;
    else if (taskType === "research") score += 0.15;

    const isComplex = score >= 0.5;
    const requiresPlanning = hasPlanning || (isComplex && (taskType === "coding" || taskType === "data-analysis"));
    const requiresValidation = hasValidation || (isComplex && taskType === "coding");

    let confidence = 0.6;

    if (maxScore > 0.3) confidence += 0.2;

    if (hasHighComplexity) confidence += 0.2;

    confidence = Math.min(confidence, 1);

    return { confidence, isComplex, requiresPlanning, requiresValidation, taskType };
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a query for search mode recommendation and task complexity.
 *
 * Combines the functionality of the backend's query-classifier.ts and task-detector.ts
 * into a single call. Used by the /internal/route endpoint.
 */
export const classifyQuery = (lastUserMessage: string): QueryClassification => {
    const { mode: searchMode } = classifySearchMode(lastUserMessage);
    const complexity = detectComplexity(lastUserMessage);

    return {
        searchMode,
        ...complexity,
    };
};
