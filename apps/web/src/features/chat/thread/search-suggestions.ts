/**
 * Search Suggestions Generator
 *
 * Generates search query refinement suggestions based on partial user input.
 * Uses pattern-based heuristics for instant, local results (no API call needed).
 * Designed for debounced autocomplete while typing in the composer.
 */

const WHITESPACE_RE = /\s+/;

export type SearchMode = "chat" | "writing" | "web" | "academic" | "x" | "reddit" | "youtube" | "stocks" | "crypto" | "code" | "github" | "spotify" | "wolfram";

export interface SearchSuggestion {
    text: string;
    type: "refinement" | "related" | "operator";
}

/**
 * Common search refinement suffixes by first-word pattern
 */
const REFINEMENT_SUFFIXES: Record<string, string[]> = {
    best: ["way to", "practices for", "tools for", "alternative to"],
    compare: ["vs", "and", "with", "to"],
    how: ["to", "does", "much does", "long does", "many", "to fix", "to use"],
    what: ["is", "are", "does", "causes", "is the best", "is the difference between"],
    when: ["was", "did", "will", "is", "does"],
    where: ["is", "can I", "to", "does", "to find"],
    who: ["is", "was", "invented", "created", "made"],
    why: ["does", "is", "do", "are", "can't", "won't"],
};

/**
 * Mode-specific suggestion templates
 */
const MODE_SUGGESTIONS: Partial<Record<SearchMode, string[]>> = {
    academic: [" research paper", " systematic review", " meta-analysis", " published 2025"],
    code: [" example", " implementation", " error", " best practice"],
    crypto: [" price", " market cap", " trading volume", " chart"],
    github: [" repository", " library", " open source", " package"],
    reddit: [" reddit", " experience", " recommendations", " opinions"],
    stocks: [" stock price", " market cap", " earnings", " forecast"],
    wolfram: [" calculate", " convert", " formula", " solve"],
    youtube: [" tutorial", " explained", " review", " walkthrough", " how to"],
};

/**
 * Generate search suggestions based on partial input and search mode.
 * @param partialQuery The user's current input text
 * @param searchMode The active search mode
 * @param maxSuggestions Maximum suggestions to return (default: 4)
 * @returns Array of search suggestions
 */
const generateSearchSuggestions = (partialQuery: string, searchMode: SearchMode, maxSuggestions = 4): SearchSuggestion[] => {
    const trimmed = partialQuery.trim();

    if (trimmed.length < 3) {
        return [];
    }

    // No suggestions for non-search modes
    if (searchMode === "chat" || searchMode === "writing") {
        return [];
    }

    const suggestions: SearchSuggestion[] = [];
    const lowerQuery = trimmed.toLowerCase();
    const words = lowerQuery.split(WHITESPACE_RE);
    const firstWord = words[0] ?? "";

    // 1. Word-completion refinements (based on first word patterns)
    if (words.length <= 3) {
        const suffixes = REFINEMENT_SUFFIXES[firstWord];

        if (suffixes) {
            for (const suffix of suffixes) {
                if (lowerQuery.includes(suffix)) {
                    continue;
                }

                suggestions.push({ text: `${trimmed} ${suffix}`, type: "refinement" });

                if (suggestions.length >= maxSuggestions) {
                    return suggestions;
                }
            }
        }
    }

    // 2. Mode-specific suggestions
    const modeSuggestions = MODE_SUGGESTIONS[searchMode];

    if (modeSuggestions) {
        for (const suffix of modeSuggestions) {
            if (lowerQuery.includes(suffix.trim().toLowerCase())) {
                continue;
            }

            suggestions.push({ text: `${trimmed}${suffix}`, type: "related" });

            if (suggestions.length >= maxSuggestions) {
                return suggestions;
            }
        }
    }

    // 3. Operator suggestions for web mode (only if query doesn't already have operators)
    if (searchMode === "web" && !lowerQuery.includes(":") && suggestions.length < maxSuggestions) {
        suggestions.push({ text: `${trimmed} site:`, type: "operator" });
    }

    return suggestions.slice(0, maxSuggestions);
};

export default generateSearchSuggestions;
