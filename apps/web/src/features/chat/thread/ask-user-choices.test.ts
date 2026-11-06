import { describe, expect, it } from "vitest";

import { isAskUserQuestionAnswered, normalizeAskUserChoices, normalizeAskUserQuestions, toggleAskUserChoice } from "./ask-user-choices";

describe(normalizeAskUserChoices, () => {
    it("drops duplicates, blanks and non-strings, keeping the model's order", () => {
        expect(normalizeAskUserChoices(["Yes", "No", "Yes", " ", 3, null, " No "])).toStrictEqual(["Yes", "No"]);
    });

    it("has no choices without an array", () => {
        expect(normalizeAskUserChoices(undefined)).toStrictEqual([]);
        expect(normalizeAskUserChoices("Yes")).toStrictEqual([]);
    });
});

describe(normalizeAskUserQuestions, () => {
    it("is undefined for the single-question form, so the card renders as it always did", () => {
        expect(normalizeAskUserQuestions(undefined)).toBeUndefined();
        expect(normalizeAskUserQuestions([])).toBeUndefined();
    });

    it("keeps the questions in order with normalized choices and the multi-select flag", () => {
        expect(
            normalizeAskUserQuestions([{ choices: ["A", "A", " "], multiSelect: true, question: " Which? " }, { question: "Why?" }, { question: " " }, 3]),
        ).toStrictEqual([
            { choices: ["A"], multiSelect: true, question: "Which?" },
            { choices: [], multiSelect: false, question: "Why?" },
        ]);
    });
});

describe(toggleAskUserChoice, () => {
    it("adds and removes in a multi-select", () => {
        expect(toggleAskUserChoice(["A"], "B", true)).toStrictEqual(["A", "B"]);
        expect(toggleAskUserChoice(["A", "B"], "A", true)).toStrictEqual(["B"]);
    });

    it("replaces in a single-select, and clears when picked again", () => {
        expect(toggleAskUserChoice(["A"], "B", false)).toStrictEqual(["B"]);
        expect(toggleAskUserChoice(["B"], "B", false)).toStrictEqual([]);
    });
});

describe(isAskUserQuestionAnswered, () => {
    it("needs a pick or a non-blank note", () => {
        expect(isAskUserQuestionAnswered({ note: " ", selected: [] })).toBe(false);
        expect(isAskUserQuestionAnswered({ note: "x", selected: [] })).toBe(true);
        expect(isAskUserQuestionAnswered({ note: "", selected: ["A"] })).toBe(true);
    });
});
