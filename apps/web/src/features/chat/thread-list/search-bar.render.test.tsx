// @vitest-environment jsdom

/**
 * The thread search input, its clear button and its close button have no visible text, so each
 * needs an accessible name of its own; the placeholder is only a hint.
 */
import { fireEvent, render, screen } from "@testing-library/react";
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

const { default: SearchBar } = await import("./search-bar");

const baseProps = {
    isSearchLoading: false,
    onClose: () => {},
    onSearchQueryChange: () => {},
    searchQuery: "report",
    searchType: "threads" as const,
};

describe("SearchBar", () => {
    it("labels the input and the clear button", () => {
        render(<SearchBar {...baseProps} />);

        expect(screen.getByRole("textbox", { name: "Search thread titles and summaries" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    });

    it("labels the input for message search", () => {
        render(<SearchBar {...baseProps} searchType="messages" />);

        expect(screen.getByRole("textbox", { name: "Search message content" })).toBeTruthy();
    });

    it("keeps the search toggle hook on the button that closes the search, and the input hook on the input", () => {
        const onClose = vi.fn();

        render(<SearchBar {...baseProps} onClose={onClose} />);

        const close = screen.getByRole("button", { name: "Close search" });

        expect(Object.hasOwn(close.dataset, "searchToggle")).toBe(true);
        expect(Object.hasOwn(screen.getByRole("textbox").dataset, "searchInput")).toBe(true);

        fireEvent.click(close);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("shows the clear button only once something is typed, and clears through the change handler", () => {
        const onSearchQueryChange = vi.fn();
        const { rerender } = render(<SearchBar {...baseProps} onSearchQueryChange={onSearchQueryChange} />);

        fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

        expect(onSearchQueryChange).toHaveBeenCalledWith("");

        rerender(<SearchBar {...baseProps} searchQuery="" />);

        expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    });
});
