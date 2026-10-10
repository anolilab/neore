"use client";

import type { BannedWordMatch } from "@visulima/content-safety";
import { checkBannedWords } from "@visulima/content-safety";
import { useState } from "react";

interface UseBannedWordValidationReturn {
    /** Clear error state (call when user edits text after a rejection) */
    clear: () => void;
    /** Error message to display, or null */
    error: string | null;
    /** Current banned word matches (empty if none) */
    matches: BannedWordMatch[];
    /** Validate text. Returns true if clean, false if banned words found. */
    validate: (text: string) => boolean;
}

const useBannedWordValidation = (): UseBannedWordValidationReturn => {
    const [matches, setMatches] = useState<BannedWordMatch[]>([]);
    const [error, setError] = useState<string | null>(null);

    const validate = (text: string): boolean => {
        const result = checkBannedWords(text);

        if (result.hasBannedWords) {
            setMatches(result.matches);
            setError("Your message contains inappropriate content that cannot be sent.");

            return false;
        }

        setMatches([]);
        setError(null);

        return true;
    };

    const clear = () => {
        setMatches([]);
        setError(null);
    };

    return { clear, error, matches, validate };
};

export default useBannedWordValidation;
