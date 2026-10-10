/**
 * Query specificity categories.
 *
 * 9-category taxonomy for *what kind of work* a query is about, distinct
 * from the 4-tier complexity score. The 23-dim scorer answers "how hard?";
 * specificity answers "for what task?". Together they let users pin a
 * (provider, model) per category so e.g. all coding turns route to Claude
 * Sonnet while all email-management turns stay on Gemini Flash.
 *
 * Detection signals:
 *   1. Active tool names (highest weight) — `web_browser`, `gmail_*`,
 *      `calendar_*` strongly indicate the category.
 *   2. Last user message keywords (regex per category).
 *   3. Tied scores fall back to "general".
 */

export type SpecificityCategory =
    | "coding"
    | "web_browsing"
    | "data_analysis"
    | "image_generation"
    | "video_generation"
    | "social_media"
    | "email_management"
    | "calendar_management"
    | "trading"
    | "general";

interface CategoryRule {
    category: SpecificityCategory;
    /** Regex over the user message — tested only when toolPrefixes don't match. */
    keywordPattern?: RegExp;
    /** Weight for tied scoring; tools always outweigh keywords. */
    keywordWeight: number;
    /** Tool-name prefixes that pin this category (matched case-insensitively). */
    toolPrefixes: ReadonlyArray<string>;
}

const RULES: ReadonlyArray<CategoryRule> = [
    {
        category: "coding",
        keywordPattern: /\b(refactor|debug|implement|stack ?trace|compile|unit test|pull request|merge conflict|typescript|python|rust)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["code_", "shell", "exec_", "python", "git_"],
    },
    {
        category: "web_browsing",
        keywordPattern: /\b(open the page|browse to|scrape|extract from this url|click the|fill the form)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["web_", "browser_", "fetch_url", "scrape_"],
    },
    {
        category: "data_analysis",
        keywordPattern: /\b(pivot table|group by|aggregate|sum the|average of|correlation|p-?value|regression|histogram|csv|xlsx)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["sql_", "query_db", "spreadsheet_", "csv_", "analyze_data"],
    },
    {
        category: "image_generation",
        keywordPattern: /\b(generate an image|render a|illustration of|photo of|design a logo|create a poster)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["image_", "create_image", "edit_image", "generate_image"],
    },
    {
        category: "video_generation",
        keywordPattern: /\b(generate a video|render a clip|animate|short film|b-?roll)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["video_", "create_video", "generate_video", "animate_"],
    },
    {
        category: "social_media",
        keywordPattern: /\b(twitter|x post|linkedin post|tweet|tiktok|reel|instagram|hashtags?|caption for)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["twitter_", "x_", "linkedin_", "instagram_", "tiktok_", "facebook_", "reddit_", "post_to_"],
    },
    {
        category: "email_management",
        keywordPattern: /\b(reply to|forward this email|inbox|draft an email|subject line|cc|bcc|compose a message)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["gmail_", "email_", "outlook_", "mailchimp_"],
    },
    {
        category: "calendar_management",
        keywordPattern: /\b(schedule a meeting|book a slot|reschedule|free\/busy|next available|calendar invite|recurring meeting)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["calendar_", "schedule_", "meeting_", "gcal_"],
    },
    {
        category: "trading",
        keywordPattern: /\b(buy order|sell order|portfolio|asset allocation|btc|ethereum|stock price|options chain|short squeeze)\b/i,
        keywordWeight: 1,
        toolPrefixes: ["trade_", "stock_", "crypto_", "portfolio_", "binance_", "coinbase_"],
    },
];

const TOOL_WEIGHT = 3;

/**
 * Confidence scales with the winning score. A tool-only hit (≥ 3) → 0.9;
 * a keyword-only hit (1) → 0.65; both → 0.95.
 */
const scoreToConfidence = (score: number): number => {
    if (score >= TOOL_WEIGHT + 1) return 0.95;

    if (score >= TOOL_WEIGHT) return 0.9;

    return 0.65;
};

/**
 * Classify a query into a specificity category.
 *
 * Tool names are inspected first — when present, the highest-scoring tool-
 * matched category wins. Keywords act as a tiebreaker / fallback when no
 * tools match.
 */
export const classifySpecificity = (lastUserMessage: string, toolNames: ReadonlyArray<string> = []): { category: SpecificityCategory; confidence: number } => {
    const tools = toolNames.map((n) => n.toLowerCase());
    const text = lastUserMessage.toLowerCase();

    const scores = new Map<SpecificityCategory, number>();

    for (const rule of RULES) {
        let score = 0;

        for (const prefix of rule.toolPrefixes) {
            if (tools.some((t) => t.startsWith(prefix))) {
                score += TOOL_WEIGHT;
            }
        }

        if (rule.keywordPattern && rule.keywordPattern.test(text)) {
            score += rule.keywordWeight;
        }

        if (score > 0) {
            scores.set(rule.category, score);
        }
    }

    let best: { category: SpecificityCategory; score: number } | undefined;

    for (const [category, score] of scores) {
        if (!best || score > best.score) {
            best = { category, score };
        }
    }

    if (!best) {
        return { category: "general", confidence: 0.5 };
    }

    return { category: best.category, confidence: scoreToConfidence(best.score) };
};

/**
 * User-pinned routes per specificity category.
 *
 * Shape: `{ "coding": { provider: "anthropic", modelId: "claude-sonnet-4" } }`.
 * When a category is pinned and `confidence ≥ 0.9`, the gateway short-circuits
 * tier-based routing and uses the pinned (provider, model) instead.
 */
export interface CategoryPin {
    modelId: string;
    provider: string;
}

export type CategoryPinMap = Partial<Record<SpecificityCategory, CategoryPin>>;

export const PIN_MIN_CONFIDENCE = 0.9;

/**
 * Resolve a category pin from a user's pinning map. Returns `undefined` when
 * no pin applies (no map, no entry for the category, or confidence too low).
 */
export const resolveCategoryPin = (category: SpecificityCategory, confidence: number, pins: CategoryPinMap | undefined): CategoryPin | undefined => {
    if (!pins || confidence < PIN_MIN_CONFIDENCE) {
        return undefined;
    }

    return pins[category];
};
