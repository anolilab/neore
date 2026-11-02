// @vitest-environment jsdom

import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ComposerInputArea from "./composer-input-area";
import { ComposerLengthNotice } from "./composer-length-notice";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});
vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return {
        ComposerTiptapEditor: () => <div data-testid="editor" />,
    };
});

describe("ComposerLengthNotice", () => {
    it("renders nothing at the cap", () => {
        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS} onAttachAsFile={() => {}} />);

        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("names the cap and offers the file once over it", () => {
        const onAttachAsFile = vi.fn();

        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} onAttachAsFile={onAttachAsFile} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");

        fireEvent.click(screen.getByRole("button", { name: "Attach as file" }));

        expect(onAttachAsFile).toHaveBeenCalledTimes(1);
    });

    it("offers no file where the text cannot become one", () => {
        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the composer over the cap", () => {
    it("shows the cap under the input", () => {
        render(<ComposerInputArea onAttachDraftAsFile={() => {}} onChange={() => {}} onSubmit={() => {}} value={"x".repeat(MAX_PROMPT_CHARS + 5)} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");
    });
});
