// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AskUserQuestionDraft, AskUserQuestionView } from "./ask-user-choices";
import type { AskUserAnswerEntry } from "./ask-user-questions";
import { AskUserAnswerList, AskUserQuestionFields } from "./ask-user-questions";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const EMPTY_DRAFT: AskUserQuestionDraft = { note: "", selected: [] };

const questions: AskUserQuestionView[] = [
    { choices: [], multiSelect: true, question: "Anything else?" },
    { choices: [], multiSelect: false, question: "Your name?" },
];

describe("AskUserQuestionFields", () => {
    it("needs a note only for a single-choice question without choices", () => {
        render(<AskUserQuestionFields disabled={false} drafts={[EMPTY_DRAFT, EMPTY_DRAFT]} idPrefix="ask" onChange={vi.fn()} questions={questions} />);

        expect(screen.getByLabelText("Note for: Anything else?").hasAttribute("required")).toBe(false);
        expect(screen.getByLabelText("Note for: Your name?").hasAttribute("required")).toBe(true);
    });
});

describe("AskUserAnswerList", () => {
    it("shows the answer, or None for an answer with nothing picked and no note", () => {
        const entries: AskUserAnswerEntry[] = [
            { question: "Anything else?", selected: [] },
            { note: "Sam", question: "Your name?", selected: [] },
        ];

        render(<AskUserAnswerList entries={entries} />);

        const [nothing, name] = screen.getAllByRole("listitem");

        expect(nothing?.textContent).toBe("Anything else?Your answer: None");
        expect(name?.textContent).toBe("Your name?Your answer: Sam");
    });
});
