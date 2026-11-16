// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineEdit } from "./inline-edit";

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const host = document.createElement("div");

document.body.append(host);

const root = createRoot(host);

/** Renders `element`, enters edit mode, and returns the input. */
const editInput = (element: React.ReactElement): HTMLInputElement => {
    act(() => root.render(element));
    act(() => (host.querySelector("[role=button]") as HTMLElement).click());

    return host.querySelector("input") as HTMLInputElement;
};

describe("InlineEdit spellCheck", () => {
    afterEach(() => {
        act(() => root.render(<></>));
    });

    it("turns spellcheck on for the built-in input", () => {
        expect(editInput(<InlineEdit spellCheck value="A title" />).getAttribute("spellcheck")).toBe("true");
    });

    it("hands spellCheck to a custom input", () => {
        expect(editInput(<InlineEdit renderInput={(props) => <input {...props} />} spellCheck value="A title" />).getAttribute("spellcheck")).toBe("true");
    });

    it("leaves the input inheriting without it", () => {
        expect(editInput(<InlineEdit value="name.txt" />).hasAttribute("spellcheck")).toBe(false);
    });
});
