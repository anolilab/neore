// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ComposerInputArea from "./composer-input-area";

// The unit-test transform does not compile Lingui macros. `plural` stands for the GLOBAL instance (it never marks its
// output); `t` stands for the active provider's, which marks everything it formats.
vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).replace("#", () => String(count)),
    };
});
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "de" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => `[de] ${String.raw({ raw: strings }, ...values)}`,
            };
        },
    };
});
vi.mock("./composer-voice-input", () => {
    return { default: () => null };
});
vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return { ComposerTiptapEditor: () => <div data-testid="editor" /> };
});

describe("the removed-characters notice", () => {
    it("is worded by the active provider's locale, not the global instance", () => {
        render(<ComposerInputArea hiddenRemoved={3} onChange={() => {}} onSubmit={() => {}} value="hi" />);

        expect(screen.getByRole("status").textContent).toBe("[de] 3 invisible characters were removed from your message.");
    });

    it("is empty when nothing was removed", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value="hi" />);

        expect(screen.getByRole("status").textContent).toBe("");
    });
});
