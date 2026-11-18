/**
 * The Ctrl+R prompt search: it lists the person's sent prompts that match, newest first, across their threads; arrow keys
 * pick a row; Enter hands that prompt back as a draft and never sends. Each search is a one-shot read, never live.
 */
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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

                              return {
                                  prompts: prompts.filter((prompt) => prompt.text.split(" ").some((word) => word.startsWith(needle))),
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

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe("ComposerPromptSearch", () => {
    it("lists the matching prompts from two threads, newest first", async () => {
        render(<ComposerPromptSearch onClose={vi.fn()} onPick={vi.fn()} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await waitFor(() => {
            expect(screen.getAllByRole("option")).toHaveLength(2);
        });

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

        await waitFor(() => {
            expect(screen.getAllByRole("option")).toHaveLength(2);
        });

        const searches = calls.filter((call) => call.args !== skipToken);

        expect(searches.length).toBeGreaterThan(0);
        expect(searches.every((call) => (call.options as { live?: boolean }).live === false)).toBe(true);
    });

    it("moves the highlight with the arrow keys and Enter hands the picked prompt back, unsent", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "deploy" } });

        await waitFor(() => {
            expect(screen.getAllByRole("option")).toHaveLength(2);
        });

        expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(input, { key: "ArrowDown" });

        expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(input, { key: "Enter" });

        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick).toHaveBeenCalledWith("deploy the staging build");
    });

    it("picks a row on click", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "deploy" } });

        await waitFor(() => {
            expect(screen.getAllByRole("option")).toHaveLength(2);
        });

        fireEvent.click(screen.getAllByRole("option")[0]!);

        expect(onPick).toHaveBeenCalledWith("deploy to production");
    });

    it("does nothing on Enter while nothing matches", async () => {
        const onPick = vi.fn();

        render(<ComposerPromptSearch onClose={vi.fn()} onPick={onPick} />, { wrapper });

        const input = screen.getByRole("combobox");

        fireEvent.change(input, { target: { value: "zzz" } });

        await waitFor(() => {
            expect(screen.getByText('No sent prompts match "zzz".')).toBeTruthy();
        });

        fireEvent.keyDown(input, { key: "Enter" });

        expect(onPick).not.toHaveBeenCalled();
    });
});
