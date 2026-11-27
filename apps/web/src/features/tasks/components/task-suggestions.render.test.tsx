// @vitest-environment jsdom

/**
 * The suggested tasks on the tasks page: nothing while there are none, a real Accept and Dismiss button per row named
 * after the suggestion, the matching procedure called with that row's id, announced outcomes, an alert on failure, and
 * focus kept after a row leaves the list.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TaskSuggestions from "./task-suggestions";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: text };
        },
    };
});

const { calls, state } = vi.hoisted(() => {
    return {
        calls: { accept: [] as unknown[], dismiss: [] as unknown[], failNext: false, lists: 0 },
        state: { rows: [] as { _id: string; cronExpression: string; instructions: string; title: string }[] },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const decide = (kind: "accept" | "dismiss") => async (args: { suggestionId: string }) => {
        calls[kind].push(args);

        if (calls.failNext) {
            calls.failNext = false;
            throw new Error("Suggestion not found");
        }

        state.rows = state.rows.filter((row) => row._id !== args.suggestionId);
    };

    return {
        useCRPC: () => {
            return {
                tasks: {
                    functions: {
                        getTaskBoard: {
                            queryOptions: () => {
                                return { queryKey: ["getTaskBoard"] };
                            },
                        },
                    },
                    suggestions: {
                        acceptTaskSuggestion: {
                            mutationOptions: (options: { onSettled?: unknown }) => {
                                return { ...options, mutationFn: decide("accept") };
                            },
                        },
                        dismissTaskSuggestion: {
                            mutationOptions: (options: { onSettled?: unknown }) => {
                                return { ...options, mutationFn: decide("dismiss") };
                            },
                        },
                        listTaskSuggestions: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        calls.lists += 1;

                                        return [...state.rows];
                                    },
                                    queryKey: ["listTaskSuggestions"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const row = (id: string, title: string, cronExpression = "0 9 * * 1") => {
    return { _id: id, cronExpression, instructions: `Do ${title} every week`, title };
};

const mountList = () => {
    const heading = createRef<HTMLHeadingElement>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // The board is on the page too: it is cached here so the refresh after Accept can be seen.
    client.setQueryData(["getTaskBoard"], { goals: [], tasks: [] });
    render(
        <QueryClientProvider client={client}>
            <h1 ref={heading} tabIndex={-1}>
                Tasks
            </h1>
            <TaskSuggestions fallbackFocus={heading} />
        </QueryClientProvider>,
    );

    return { client };
};

/** Whether the element holds focus: the focus is what is asserted. */
const hasFocus = (element: HTMLElement): boolean => document.activeElement === element; // eslint-disable-line testing-library/no-node-access

beforeEach(() => {
    calls.accept = [];
    calls.dismiss = [];
    calls.failNext = false;
    calls.lists = 0;
    state.rows = [];
});

describe("TaskSuggestions", () => {
    it("renders nothing when there are no suggestions", async () => {
        mountList();

        // The list was read and came back empty: no heading, no list, no buttons, no live region.
        await waitFor(() => expect(calls.lists).toBeGreaterThan(0));
        await Promise.resolve();

        expect(screen.queryByText("Suggested tasks")).toBeNull();
        expect(screen.queryByRole("list")).toBeNull();
        expect(screen.queryAllByRole("button")).toHaveLength(0);
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows each suggestion with its schedule in words and buttons named after it", async () => {
        state.rows = [row("s1", "Weekly notes"), row("s2", "Morning plants", "30 8 * * 1-5"), row("s3", "Odd one", "0 9 1,15 * *")];
        mountList();

        expect(await screen.findByRole("button", { name: 'Accept "Weekly notes"' })).toBeTruthy();
        expect(screen.getByRole("button", { name: 'Dismiss "Weekly notes"' })).toBeTruthy();
        expect(screen.getByRole("button", { name: 'Accept "Morning plants"' })).toBeTruthy();
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
        expect(screen.getByText("Mondays at 09:00 UTC")).toBeTruthy();
        expect(screen.getByText("Weekdays at 08:30 UTC")).toBeTruthy();
        expect(screen.getByText("Repeats (0 9 1,15 * * UTC)")).toBeTruthy();
    });

    it("calls the accept procedure with the row's id, announces the task and refreshes the board", async () => {
        state.rows = [row("s1", "Weekly notes"), row("s2", "Morning plants")];
        const { client } = mountList();

        fireEvent.click(await screen.findByRole("button", { name: 'Accept "Morning plants"' }));

        await waitFor(() => expect(calls.accept).toEqual([{ suggestionId: "s2" }]));
        expect(calls.dismiss).toEqual([]);
        await waitFor(() => expect(screen.queryByRole("button", { name: 'Accept "Morning plants"' })).toBeNull());
        const status = await screen.findByRole("status", { name: "Suggestion updates" });

        expect(status.textContent).toBe("Task created: Morning plants");
        await waitFor(() => expect(client.getQueryState(["getTaskBoard"])?.isInvalidated).toBe(true));
    });

    it("calls the dismiss procedure with the row's id, and never accepts", async () => {
        state.rows = [row("s1", "Weekly notes"), row("s2", "Morning plants")];
        mountList();

        fireEvent.click(await screen.findByRole("button", { name: 'Dismiss "Weekly notes"' }));

        await waitFor(() => expect(calls.dismiss).toEqual([{ suggestionId: "s1" }]));
        expect(calls.accept).toEqual([]);
        await waitFor(() => expect(screen.getByRole("status", { name: "Suggestion updates" }).textContent).toBe("Suggestion dismissed: Weekly notes"));
    });

    it("puts focus on the next row when one leaves, and on the page heading when the last one does", async () => {
        state.rows = [row("s1", "Weekly notes"), row("s2", "Morning plants")];
        mountList();

        fireEvent.click(await screen.findByRole("button", { name: 'Dismiss "Weekly notes"' }));
        await waitFor(() => expect(screen.queryByRole("button", { name: 'Dismiss "Weekly notes"' })).toBeNull());
        await waitFor(() => expect(hasFocus(screen.getByRole("listitem"))).toBe(true));

        fireEvent.click(screen.getByRole("button", { name: 'Accept "Morning plants"' }));
        await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
        await waitFor(() => expect(hasFocus(screen.getByRole("heading", { name: "Tasks" }))).toBe(true));
        // The last row's outcome is still announced, with no heading or list left on screen.
        expect(screen.getByRole("status", { name: "Suggestion updates" }).textContent).toBe("Task created: Morning plants");
        expect(screen.queryByText("Suggested tasks")).toBeNull();
    });

    it("shows an alert, keeps the row and leaves focus on its button when the call fails", async () => {
        state.rows = [row("s1", "Weekly notes")];
        calls.failNext = true;
        mountList();

        const accept = await screen.findByRole("button", { name: 'Accept "Weekly notes"' });

        accept.focus();
        fireEvent.click(accept);

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Failed to create the task");
        expect(hasFocus(screen.getByRole("button", { name: 'Accept "Weekly notes"' }))).toBe(true);

        // The next attempt clears the alert.
        fireEvent.click(screen.getByRole("button", { name: 'Accept "Weekly notes"' }));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
});
