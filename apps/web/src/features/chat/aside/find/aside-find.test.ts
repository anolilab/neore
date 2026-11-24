import { describe, expect, it } from "vitest";

import { findMatches } from "@/features/chat/thread/find/match";

import type { AsideEntry } from "../aside-store";
import { asideFindMessages } from "./aside-find";

const answered = (id: string, question: string, answer: string): AsideEntry => {
    return { answer, id, question, status: "answered" };
};

describe("asideFindMessages", () => {
    it("holds the question and, once there is one, the answer as the entry's text", () => {
        expect(asideFindMessages([answered("a", "Why", "Because")])).toEqual([
            {
                id: "a",
                parts: [
                    { text: "Why", type: "text" },
                    { text: "Because", type: "text" },
                ],
                role: "user",
            },
        ]);
    });

    it("holds only the question while the answer is still pending", () => {
        const [message] = asideFindMessages([{ id: "a", question: "Why", status: "pending" }]);

        expect(message?.parts).toEqual([{ text: "Why", type: "text" }]);
    });
});

describe("side-question find matches", () => {
    it("counts every question and answer in the panel's order, and only the entries that hit", () => {
        const entries: AsideEntry[] = [
            answered("a", "Cat plan", "the cat sleeps"),
            { id: "b", question: "dog", status: "pending" },
            answered("c", "a dog", "no hit here"),
        ];

        expect(findMatches(asideFindMessages(entries), "cat")).toEqual([
            { messageId: "a", occurrence: 0 },
            { messageId: "a", occurrence: 1 },
        ]);
        expect(findMatches(asideFindMessages(entries), "dog")).toEqual([
            { messageId: "b", occurrence: 0 },
            { messageId: "c", occurrence: 0 },
        ]);
    });

    it("finds nothing for an empty query or a missing word", () => {
        const messages = asideFindMessages([answered("a", "Cat", "sleeps")]);

        expect(findMatches(messages, " ".repeat(3))).toEqual([]);
        expect(findMatches(messages, "owl")).toEqual([]);
    });
});
