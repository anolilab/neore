/** Editing a pending comment saves its text and keeps the line range it was written for. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DraftComment } from "./review-diff";

const { saveComment } = vi.hoisted(() => {
    return {
        saveComment: vi.fn(async () => {
            return { status: "ok" };
        }),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: ({ value }: { value: number }) => <>{value}</>,
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t: text };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return { plural: String };
});

vi.mock("../lib/use-review", () => {
    return {
        useDraftMutations: () => {
            return { deleteComment: { mutateAsync: vi.fn() }, saveComment: { mutateAsync: saveComment } };
        },
    };
});

vi.mock("../lib/use-review-messages", () => {
    return {
        useReviewMessages: () => {
            return { edit: String, write: String };
        },
    };
});

describe("DraftComment", () => {
    it("sends the stored start line when only the text changed", async () => {
        render(
            <DraftComment
                address={{ number: 7, repository: "octo/hello" }}
                comment={{ body: "old", id: "c1", line: 12, path: "src/a.ts", side: "new", startLine: 10 }}
                headSha={"a".repeat(40)}
                hostLabel="GitHub"
                locked={false}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "new text" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(saveComment).toHaveBeenCalledTimes(1));
        expect(saveComment).toHaveBeenCalledWith(expect.objectContaining({ body: "new text", commentId: "c1", line: 12, startLine: 10 }));
    });
});
