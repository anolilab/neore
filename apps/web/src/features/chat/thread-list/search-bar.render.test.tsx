// @vitest-environment jsdom

/**
 * The thread search input and its clear button have no visible text, so each
 * needs an accessible name of its own; the placeholder is only a hint.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/chat/tags/thread-category-filter", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/tags/thread-tag-filter", () => {
    return { default: () => null };
});

vi.mock("./stores/thread-list-ui-store", () => {
    return {
        selectSelectedTagIds: (state: unknown) => state,
        selectSetSelectedTagIds: () => {},
        selectSetShowManageTagsDialog: () => {},
        useThreadListUIStore: () => [],
    };
});

const { default: SearchBar } = await import("./search-bar");

const baseProps = {
    isSearchLoading: false,
    onSearchQueryChange: () => {},
    onSearchTypeChange: () => {},
    onSelectedCategoryChange: () => {},
    searchQuery: "report",
    searchType: "threads" as const,
};

describe("SearchBar", () => {
    it("labels the input and the clear button", () => {
        render(<SearchBar {...baseProps} />);

        expect(screen.getByRole("textbox", { name: "Search thread titles" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    });

    it("labels the input for message search", () => {
        render(<SearchBar {...baseProps} searchType="messages" />);

        expect(screen.getByRole("textbox", { name: "Search message content" })).toBeTruthy();
    });
});
