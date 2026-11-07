"use client";

/**
 * The parts of the `askUser` card that only a multi-question call has (`questions`): the fields to answer them in one
 * form, and the read-only list of the answers afterwards. The card itself is `ask-user-prompt.tsx`.
 */

import { useLingui } from "@lingui/react/macro";
import { ASK_USER_ANSWER_MAX } from "@neore/backend/ask-user-limits";
import { Textarea } from "@neore/ui/components/textarea";
import type { FC } from "react";

import type { AskUserQuestionDraft, AskUserQuestionView } from "./ask-user-choices";
import { toggleAskUserChoice } from "./ask-user-choices";

/** What the card shows for one answered question. */
export interface AskUserAnswerEntry {
    note?: string;
    question: string;
    selected: string[];
}

/** One fieldset per question: its choices (checkboxes when several may be picked, radios otherwise) and a note. */
export const AskUserQuestionFields: FC<{
    disabled: boolean;
    drafts: ReadonlyArray<AskUserQuestionDraft>;
    idPrefix: string;
    onChange: (index: number, patch: Partial<AskUserQuestionDraft>) => void;
    questions: ReadonlyArray<AskUserQuestionView>;
}> = ({ disabled, drafts, idPrefix, onChange, questions }) => {
    const { t } = useLingui();

    return questions.map((entry, index) => {
        const current = drafts[index] ?? { note: "", selected: [] };
        const noteId = `${idPrefix}-note-${String(index)}`;

        return (
            <fieldset className="flex flex-col gap-2" key={entry.question}>
                <legend className="mb-1 text-sm font-medium whitespace-pre-wrap">{entry.question}</legend>
                {entry.choices.map((choice, choiceIndex) => (
                    <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-${String(index)}-${String(choiceIndex)}`} key={choice}>
                        <input
                            checked={current.selected.includes(choice)}
                            disabled={disabled}
                            id={`${idPrefix}-${String(index)}-${String(choiceIndex)}`}
                            name={`${idPrefix}-${String(index)}`}
                            onChange={() => onChange(index, { selected: toggleAskUserChoice(current.selected, choice, entry.multiSelect) })}
                            // A checked radio fires no change when clicked again, so a click on the picked choice clears it here.
                            onClick={() => {
                                if (!entry.multiSelect && current.selected.includes(choice)) {
                                    onChange(index, { selected: [] });
                                }
                            }}
                            type={entry.multiSelect ? "checkbox" : "radio"}
                        />
                        <span>{choice}</span>
                    </label>
                ))}
                <Textarea
                    aria-label={t`Note for: ${entry.question}`}
                    id={noteId}
                    maxLength={ASK_USER_ANSWER_MAX}
                    onChange={(event) => onChange(index, { note: event.target.value })}
                    placeholder={entry.choices.length > 0 ? t`Add a note (optional)…` : t`Type your answer…`}
                    required={entry.choices.length === 0}
                    rows={2}
                    size="sm"
                    value={current.note}
                />
            </fieldset>
        );
    });
};

/** The answers of a multi-question card, read-only: each question with its picks and note. */
export const AskUserAnswerList: FC<{ entries: ReadonlyArray<AskUserAnswerEntry> }> = ({ entries }) => {
    const { t } = useLingui();

    return (
        <ul className="mt-2 flex flex-col gap-2">
            {entries.map((entry) => (
                <li className="bg-background rounded-md border px-3 py-2 text-sm" key={entry.question}>
                    <p className="text-muted-foreground text-xs whitespace-pre-wrap">{entry.question}</p>
                    <p className="whitespace-pre-wrap">
                        <span className="sr-only">{t`Your answer:`} </span>
                        {[entry.selected.join(", "), entry.note].filter(Boolean).join(" — ")}
                    </p>
                </li>
            ))}
        </ul>
    );
};
