/**
 * Search Suggestions Generator
 *
 * Generates search query refinement suggestions based on partial user input.
 * Uses pattern-based heuristics for instant results (no LLM call needed).
 * Designed to be called from an action for debounced autocomplete.
 */

import type { SearchMode } from "./tool-builder";

const WHITESPACE_RE = /\s+/;

export interface SearchSuggestion {
    text: string;
    type: "refinement" | "related" | "operator";
}

/**
 * Common search refinement suffixes by category
 */
const REFINEMENT_SUFFIXES: Record<string, string[]> = {
    best: ["way to", "practices for", "tools for", "alternative to", "free"],
    compare: ["vs", "and", "with", "to"],
    how: ["to", "does", "much does", "long does", "many", "to fix", "to use", "it works"],
    what: ["is", "are", "does", "causes", "is the best", "is the difference between", "happened to"],
    when: ["was", "did", "will", "is", "does", "should I"],
    where: ["is", "can I", "to", "does", "should I", "to find"],
    who: ["is", "was", "invented", "created", "made", "discovered"],
    why: ["does", "is", "do", "are", "can't", "won't", "should I"],
};

/**
 * Mode-specific suggestion templates
 */
const MODE_SUGGESTIONS: Partial<Record<SearchMode, string[]>> = {
    academic: [" research paper", " systematic review", " meta-analysis", " journal article", " published 2024", " published 2025", " PDF"],
    code: [" example", " implementation", " error", " bug fix", " best practice", " TypeScript", " Python"],
    crypto: [" price", " market cap", " trading volume", " chart", " prediction"],
    github: [" repository", " library", " framework", " open source", " package", " tool"],
    reddit: [" reddit", " experience", " recommendations", " opinions", " review", " alternative"],
    stocks: [" stock price", " market cap", " earnings", " forecast", " dividend"],
    wolfram: [" calculate", " convert", " formula", " equation", " graph", " solve"],
    youtube: [" tutorial", " explained", " review", " walkthrough", " how to", " guide"],
};

/**
 * Search operator suggestions
 */
const OPERATOR_SUGGESTIONS: SearchSuggestion[] = [
    { text: "site:", type: "operator" },
    { text: "filetype:pdf", type: "operator" },
    { text: "after:2025", type: "operator" },
    { text: "before:", type: "operator" },
];

/**
 * Generate search suggestions based on partial input and search mode.
 * @param partialQuery The user's current input text
 * @param searchMode The active search mode
 * @param maxSuggestions Maximum suggestions to return (default: 5)
 * @returns Array of search suggestions
 */
const generateSearchSuggestions = (partialQuery: string, searchMode: SearchMode, maxSuggestions = 5): SearchSuggestion[] => {
    const trimmed = partialQuery.trim();

    if (trimmed.length < 2) {
        return [];
    }

    // No suggestions for non-search modes
    if (searchMode === "chat" || searchMode === "writing") {
        return [];
    }

    const suggestions: SearchSuggestion[] = [];
    const lowerQuery = trimmed.toLowerCase();
    const words = lowerQuery.split(WHITESPACE_RE);
    const lastWord = words.at(-1) ?? "";
    const firstWord = words[0] ?? "";

    // 1. Word-completion refinements (based on first word patterns)
    if (words.length <= 3) {
        const suffixes = REFINEMENT_SUFFIXES[firstWord];

        if (suffixes) {
            for (const suffix of suffixes) {
                if (lowerQuery.includes(suffix)) {
                    continue;
                }

                suggestions.push({
                    text: `${trimmed} ${suffix}`,
                    type: "refinement",
                });

                if (suggestions.length >= maxSuggestions) {
                    break;
                }
            }
        }
    }

    // 2. Mode-specific suggestions
    const modeSuggestions = MODE_SUGGESTIONS[searchMode];

    if (modeSuggestions && suggestions.length < maxSuggestions) {
        for (const suffix of modeSuggestions) {
            const candidate = `${trimmed}${suffix}`;

            // Only add if suffix doesn't overlap with existing query
            if (!lowerQuery.includes(suffix.trim().toLowerCase())) {
                suggestions.push({ text: candidate, type: "related" });

                if (suggestions.length >= maxSuggestions) {
                    break;
                }
            }
        }
    }

    // 3. Operator suggestions for web mode (only if query doesn't already have operators)
    if (searchMode === "web" && !lowerQuery.includes(":") && suggestions.length < maxSuggestions) {
        for (const op of OPERATOR_SUGGESTIONS) {
            suggestions.push({
                text: `${trimmed} ${op.text}`,
                type: "operator",
            });

            if (suggestions.length >= maxSuggestions) {
                break;
            }
        }
    }

    // 4. Common question patterns if the query looks incomplete
    if (words.length >= 2 && lastWord.length <= 2 && suggestions.length < maxSuggestions) {
        const questionCompletions = [`${trimmed} in 2025`, `${trimmed} explained`, `${trimmed} example`];

        for (const completion of questionCompletions) {
            suggestions.push({ text: completion, type: "refinement" });

            if (suggestions.length >= maxSuggestions) {
                break;
            }
        }
    }

    return suggestions.slice(0, maxSuggestions);
};

export default generateSearchSuggestions;
