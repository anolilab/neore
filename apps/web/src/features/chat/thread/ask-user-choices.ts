/**
 * The suggested answers of an `askUser` call, as the model supplied them:
 * only non-blank strings, each once (a duplicate would render two identical
 * buttons with the same React key), trimmed, in the model's order.
 */
export const normalizeAskUserChoices = (choices: unknown): string[] => {
    if (!Array.isArray(choices)) {
        return [];
    }

    const seen = new Set<string>();

    for (const choice of choices) {
        if (typeof choice === "string" && choice.trim().length > 0) {
            seen.add(choice.trim());
        }
    }

    return [...seen];
};

/** One question of a multi-question `askUser` call, as the card shows it. */
export interface AskUserQuestionView {
    choices: string[];
    multiSelect: boolean;
    question: string;
}

/** What the person has picked and typed for one question. */
export interface AskUserQuestionDraft {
    note: string;
    selected: string[];
}

/**
 * The questions of a multi-question call, as the model supplied them: only entries with question text, each with its
 * normalized choices. `undefined` when the call is the single-question form (or carries no usable question), so the
 * card falls back to `question` + `choices` exactly as before.
 */
export const normalizeAskUserQuestions = (questions: unknown): AskUserQuestionView[] | undefined => {
    if (!Array.isArray(questions)) {
        return undefined;
    }

    const views = questions.flatMap((entry: unknown) => {
        const { choices, multiSelect, question } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;

        return typeof question === "string" && question.trim().length > 0
            ? [{ choices: normalizeAskUserChoices(choices), multiSelect: multiSelect === true, question: question.trim() }]
            : [];
    });

    return views.length > 0 ? views : undefined;
};

/** The picks after the person toggles `choice`: a multi-select adds or removes it, a single-select replaces it (or clears it when picked again). */
export const toggleAskUserChoice = (selected: ReadonlyArray<string>, choice: string, multiSelect: boolean): string[] => {
    if (multiSelect) {
        return selected.includes(choice) ? selected.filter((entry) => entry !== choice) : [...selected, choice];
    }

    return selected.includes(choice) ? [] : [choice];
};

/** A question counts as answered by a pick or a non-blank note. */
export const isAskUserQuestionAnswered = (draft: AskUserQuestionDraft): boolean => draft.selected.length > 0 || draft.note.trim().length > 0;
