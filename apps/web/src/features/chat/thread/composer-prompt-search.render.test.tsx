/**
 * The Ctrl+R prompt search: it lists the person's sent prompts that match, newest first, across their threads; arrow keys
 * pick a row; Enter hands that prompt back as a draft and never sends. Each search is a one-shot read, never live.
 */
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, prompts } = vi.hoisted(() => {
    return {
        calls: [] as { args: unknown; options: unknown }[],
        prompts: [
            { createdAt: 300, messageId: "m-notes", text: "deploy to production", threadId: "t-notes", threadTitle: "Notes" },
            { createdAt: 100, messageId: "m-release", text: "deploy the staging build", threadId: "t-release", threadTitle: "Release" },
            { createdAt: 200, messageId: "m-other", text: "summarise the invoice", threadId: "t-notes", threadTitle: "Notes" },
        ],
    };
});

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).replace("#", () => String(count)),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

// The search answers from the prompts above, matched on the word the person typed, as the server's word match does.
vi.mock("@/lib/lunora/crpc", () => {
    const searchSentPrompts = {
        queryOptions: (args: unknown, options: unknown) => {
            calls.push({ args, options });

            return {
                queryFn:
                    args === skipToken
                        ? skipToken
                        : async () => {
                              const needle = (args as { searchQuery: string }).searchQuery.toLowerCase();

                              if (needle === "boom") {
                                  throw new Error("the search could not run");
                              }

                              return {
                                  prompts: prompts.filter((prompt) => prompt.text.split(" ").some((word) => word.startsWith(needle))),
                                  truncated: needle === "many",
                              };
                          },
                queryKey: ["searchSentPrompts", args],
            };
        },
    };

    return {
        useCRPC: () => {
            return { chat: { functions: { searchSentPrompts } } };
        },
    };
});

const { default: ComposerPromptSearch } = await import("./composer-prompt-search");

// jsdom has no layout or scrolling; the search asks the highlighted row to scroll into view.
Element.prototype.scrollIntoView = () => {};

// A failed search answers at once: the production client would retry it first.
const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

/**
 * Past the 200 ms debounce, with the search's answer drawn: fake timers, so no test waits on the clock. React renders what
 * a timer set only when `act` ends, and the query starts from that render, so the timers run again in a second `act`.
 */
const settle = async (ms = 250) => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
};

const searchedTexts = () => calls.filter((call) => call.args !== skipToken).map((call) => (call.args as { searchQuery: string }).searchQuery);

describe("ComposerPromptSearch", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("lists the matching prompts from two threads, newest first", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await settle();

        expect(screen.getAllByRole("option")).toHaveLength(2);

        const options = screen.getAllByRole("option");

        expect(options[0]?.textContent).toContain("deploy to production");
        expect(options[0]?.textContent).toContain("Notes");
        expect(options[1]?.textContent).toContain("deploy the staging build");
        expect(options[1]?.textContent).toContain("Release");
        expect(screen.queryByText("summarise the invoice")).toBeNull();
    });

    it("answers each search as a one-shot read, never live", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await settle();

        expect(screen.getAllByRole("option")).toHaveLength(2);

        const searches = calls.filter((call) => call.args !== skipToken);

        expect(searches.length).toBeGreaterThan(0);
        expect(searches.every((call) => (call.options as { live?: boolean }).live === false)).toBe(true);
    });

    it("moves the highlight with the arrow keys and Enter hands the picked prompt back, unsent", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "deploy" } });

        await settle();

        expect(screen.getAllByRole("option")).toHaveLength(2);

        expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(input, { key: "ArrowDown" });

        expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(input, { key: "Enter" });

        await settle();

        expect(onPick).toHaveBeenCalledTimes(1);

        expect(onPick).toHaveBeenCalledWith({ text: "deploy the staging build" });
    });

    it("scrolls each newly highlighted row into view", async () => {
        const scrollIntoView = vi.fn();

        Element.prototype.scrollIntoView = scrollIntoView;

        try {
            render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

            const input = screen.getByRole("combobox");

            fireEvent.change(input, { target: { value: "deploy" } });

            await settle();

            expect(screen.getAllByRole("option")).toHaveLength(2);

            fireEvent.keyDown(input, { key: "ArrowDown" });

            const options = screen.getAllByRole("option");

            expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
            expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[1]);

            fireEvent.keyDown(input, { key: "ArrowUp" });

            expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[0]);
        } finally {
            Element.prototype.scrollIntoView = () => {};
        }
    });

    it("waits out the debounce before it searches what was typed", async () => {
        calls.length = 0;

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        // The production debounce is 200 ms: just short of it, nothing has been searched for the new text yet.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(199);
        });

        expect(searchedTexts()).not.toContain("deploy");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });

        expect(searchedTexts()).toContain("deploy");
    });

    it("says the search failed, not that nothing matched", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "boom" } });

        await settle();

        expect(screen.getByText("The search failed. Try again.")).toBeTruthy();

        expect(screen.queryByText("No sent prompts match", { exact: false })).toBeNull();
    });

    it("says when only the best matches were searched", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "many" } });

        await settle();

        expect(screen.getByText("Only the best matches are searched", { exact: false })).toBeTruthy();
    });

    it("keeps the keys it answers from also reaching a global shortcut", async () => {
        const reached: string[] = [];
        const listener = (event: KeyboardEvent) => {
            reached.push(event.key);
        };

        document.addEventListener("keydown", listener);

        try {
            const onPick = vi.fn();

            render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

            const input = screen.getByRole("combobox");

            fireEvent.change(input, { target: { value: "deploy" } });

            await settle();

            expect(screen.getAllByRole("option")).toHaveLength(2);

            fireEvent.keyDown(input, { key: "ArrowDown" });
            fireEvent.keyDown(input, { key: "Enter" });

            await settle();

            expect(onPick).toHaveBeenCalledTimes(1);

            expect(reached).toEqual([]);
        } finally {
            document.removeEventListener("keydown", listener);
        }
    });

    it("closes on Escape, and Escape does not reach a global shortcut", async () => {
        const onClose = vi.fn();
        const reached: string[] = [];
        const listener = (event: KeyboardEvent) => {
            reached.push(event.key);
        };

        document.addEventListener("keydown", listener);

        try {
            render(<ComposerPromptSearch onClose={onClose} onPick={vi.fn()} />, { wrapper });

            const input = screen.getByRole("combobox");

            fireEvent.change(input, { target: { value: "deploy" } });

            await settle();

            expect(screen.getAllByRole("option")).toHaveLength(2);

            fireEvent.keyDown(input, { key: "Escape" });

            expect(onClose).toHaveBeenCalledTimes(1);
            expect(reached).toEqual([]);
        } finally {
            document.removeEventListener("keydown", listener);
        }
    });

    it("picks a row on click", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await settle();

        expect(screen.getAllByRole("option")).toHaveLength(2);

        fireEvent.click(screen.getAllByRole("option")[0]!);

        await settle();

        expect(onPick).toHaveBeenCalledWith({ text: "deploy to production" });
    });

    it("refuses a prompt that the re-check no longer finds, and says so", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await settle();

        expect(screen.getAllByRole("option")).toHaveLength(2);

        // The prompt leaves the search after the list was drawn, as when its thread is locked. It must not reach the composer.
        const index = prompts.findIndex((prompt) => prompt.messageId === "m-notes");
        const [removed] = prompts.splice(index, 1);

        try {
            fireEvent.click(screen.getAllByRole("option")[0]!);

            await settle();

            expect(screen.getByText("That prompt is no longer available. Pick another.")).toBeTruthy();

            expect(onPick).not.toHaveBeenCalled();
            expect(screen.getAllByRole("option")).toHaveLength(1);
        } finally {
            prompts.splice(index, 0, removed!);
        }
    });

    it("does nothing on Enter while nothing matches", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "zzz" } });

        await settle();

        expect(screen.getByText('No sent prompts match "zzz".')).toBeTruthy();

        fireEvent.keyDown(input, { key: "Enter" });

        expect(onPick).not.toHaveBeenCalled();
    });

    it("picks nothing from the previous search while a changed query waits out the debounce", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "deploy" } });
        await settle();

        fireEvent.change(input, { target: { value: "summarise" } });
        // The list still shows the "deploy" rows: neither Enter nor a click may put one in the draft.
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.click(screen.getAllByRole("option")[0]!);
        await settle(0);

        expect(onPick).not.toHaveBeenCalled();
    });

    it("steps to the next match on Ctrl+R and keeps it from the browser's reload", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "deploy" } });
        await settle();

        const reload = fireEvent.keyDown(input, { ctrlKey: true, key: "r" });

        expect(reload).toBe(false);
        expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    });

    it("drops a pick whose check finishes after the search closed", async () => {
        const onPick = vi.fn();
        const { unmount } = render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });
        await settle();

        fireEvent.click(screen.getAllByRole("option")[0]!);
        unmount();
        await settle(0);

        expect(onPick).not.toHaveBeenCalled();
    });

    it("drops a pick, and its notice, when the search changes while the check runs", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "deploy" } });
        await settle();

        // Typed again before the check answered: the "deploy" row must not reach the draft.
        fireEvent.click(screen.getAllByRole("option")[0]!);
        fireEvent.change(input, { target: { value: "deplo" } });
        await settle();

        expect(onPick).not.toHaveBeenCalled();

        // A pick the check refuses after the change says nothing over the new list.
        const index = prompts.findIndex((prompt) => prompt.messageId === "m-notes");
        const [removed] = prompts.splice(index, 1);

        try {
            fireEvent.click(screen.getAllByRole("option")[0]!);
            fireEvent.change(input, { target: { value: "deploy" } });
            await settle();

            expect(screen.queryByText("That prompt is no longer available. Pick another.")).toBeNull();
            expect(onPick).not.toHaveBeenCalled();
        } finally {
            prompts.splice(index, 0, removed!);
        }
    });

    it("counts one match in the singular and says in the status that the list may be incomplete", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "summarise" } });
        await settle();

        expect(screen.getByRole("status").textContent).toContain("1 prompt found");

        fireEvent.change(input, { target: { value: "many" } });
        await settle();

        expect(screen.getByRole("status").textContent).toContain("Only the best matches are searched");
    });
});
