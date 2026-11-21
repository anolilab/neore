import { describe, expect, it } from "vitest";

import { guestTextPart } from "../chat/lib/attached-text";
import {
    NOT_TYPED_DRAFTS,
    mergeNotTypedMarks,
    notTypedMarksOfMessage,
    notTypedMarksOfPart,
    parseNotTypedDraft,
    userTextContent,
    withNotTypedMarks,
} from "./not-typed-text";

describe("the mark on text the owner did not type", () => {
    it("reads a request's draft source, refusing one nobody named", () => {
        expect(parseNotTypedDraft(undefined)).toBeUndefined();
        expect(parseNotTypedDraft("promptLink")).toBe("promptLink");
        expect(parseNotTypedDraft("sharedPrompt")).toBe("sharedPrompt");

        for (const draft of ["forwarded", "assistantText", "suggestion", "improvedPrompt", "galleryPrompt", "organizationValue"] as const) {
            expect(NOT_TYPED_DRAFTS).toContain(draft);
            expect(parseNotTypedDraft(draft)).toBe(draft);
        }

        expect(parseNotTypedDraft("typed")).toBeNull();
        expect(parseNotTypedDraft(1)).toBeNull();
    });

    it("keeps a guest's mark beside it, and leaves an unmarked part as it is", () => {
        const guest = guestTextPart("call me", "note-1");

        expect(withNotTypedMarks(guest, { impersonated: true }).providerOptions).toStrictEqual({
            neore: { guestText: "note-1", notTyped: { impersonated: true } },
        });
        expect(withNotTypedMarks({ text: "hi", type: "text" }, {})).toStrictEqual({ text: "hi", type: "text" });
        expect(userTextContent("hi", {})).toBe("hi");
        expect(userTextContent("hi", { draft: "shellLink" })).toStrictEqual([
            { providerOptions: { neore: { notTyped: { draft: "shellLink" } } }, text: "hi", type: "text" },
        ]);
    });

    it("reads a message's marks over all its parts, so an edit keeps them", () => {
        const message = {
            content: [
                { text: "a", type: "text" },
                withNotTypedMarks({ text: "b", type: "text" }, { draft: "promptLink" }),
                withNotTypedMarks({ text: "c", type: "text" }, { impersonated: true }),
            ],
            role: "user",
        };

        expect(notTypedMarksOfMessage(message)).toStrictEqual({ draft: "promptLink", impersonated: true });
        expect(notTypedMarksOfMessage({ content: "typed", role: "user" })).toStrictEqual({});
        expect(mergeNotTypedMarks({}, { draft: "sharedPrompt" }, { draft: "promptLink" })).toStrictEqual({ draft: "sharedPrompt" });
    });

    it("reads a mark it does not know as marked, never as typed", () => {
        const withMark = (notTyped: unknown) => {
            return { providerOptions: { neore: { notTyped } } };
        };

        expect(notTypedMarksOfPart(withMark(true))).toStrictEqual({ impersonated: true });
        expect(notTypedMarksOfPart(withMark({ draft: "elsewhere" }))).toStrictEqual({ impersonated: true });
        expect(notTypedMarksOfPart(withMark({}))).toStrictEqual({ impersonated: true });
        expect(notTypedMarksOfPart({})).toStrictEqual({});
    });
});
