/**
 * Validators for the answers to a multi-question `askUser` call, shared by the `answerAskUser` procedure (what the
 * client sends) and `continueAfterToolApproval` (what the resumed run carries). Kept apart from
 * `ask-user-constants.ts`, which must load without the validator library.
 */
import { v } from "lunorash/server";

import { ASK_USER_ANSWER_MAX, ASK_USER_CHOICE_MAX, ASK_USER_MAX_CHOICES, ASK_USER_MAX_QUESTIONS, ASK_USER_QUESTION_MAX } from "./ask-user-constants";

const countBetween = (min: number, max: number) => (value: ReadonlyArray<unknown>) => value.length >= min && value.length <= max;

/** What the client sends per question: the choices picked and an optional note, by the question's position. */
export const vAskUserReplies = v
    .array(
        v.object({
            note: v.optional(v.string().check((value) => value.length <= ASK_USER_ANSWER_MAX * 2, { message: "Note too long" })),
            selected: v.array(v.string().max(ASK_USER_CHOICE_MAX * 2)).check(countBetween(0, ASK_USER_MAX_CHOICES), { message: "Too many choices" }),
        }),
    )
    .check(countBetween(1, ASK_USER_MAX_QUESTIONS), { message: "Invalid number of answers" });

/** What the resumed run carries per question, after the claim joined the replies to the questions. */
export const vAskUserAnswers = v
    .array(
        v.object({
            note: v.optional(v.string().max(ASK_USER_ANSWER_MAX)),
            question: v.string().max(ASK_USER_QUESTION_MAX),
            selected: v.array(v.string().max(ASK_USER_CHOICE_MAX)),
        }),
    )
    .check(countBetween(1, ASK_USER_MAX_QUESTIONS), { message: "Invalid number of answers" });
