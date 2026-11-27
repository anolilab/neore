// @vitest-environment jsdom

/**
 * The suggested tasks on the tasks page: nothing while there are none, a real Accept and Dismiss button per row named
 * after the suggestion, the matching procedure called with that row's id, announced outcomes, an alert on failure, a decided
 * row leaving the list at once, and focus kept after a row leaves the list.
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
        calls: { accept: [] as unknown[], dismiss: [] as unknown[], failList: false, failNext: false, holdNext: null as Promise<void> | null, lists: 0 },
        state: { live: true, rows: [] as { _id: string; cronExpression: string; instructions: string; title: string }[] },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const decide = (kind: "accept" | "dismiss") => async (args: { suggestionId: string }) => {
        calls[kind].push(args);

        if (calls.holdNext) {
            await calls.holdNext;
            calls.holdNext = null;
        }

        if (calls.failNext) {
            calls.failNext = false;
            throw new Error("Suggestion not found");
        }

        // A live list that has not pushed yet keeps answering with the decided row.
        if (state.live) {
            state.rows = state.rows.filter((row) => row._id !== args.suggestionId);
        }
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

                                        if (calls.failList) {
                                            throw new Error("offline");
                                        }

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
            <button type="button">New task</button>
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
    calls.failList = false;
    calls.failNext = false;
    calls.holdNext = null;
    calls.lists = 0;
    state.live = true;
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
        expect(screen.queryAllByRole("button").map((button) => button.textContent)).toEqual(["New task"]);
        expect(screen.queryByRole("alert")).toBeNull();
        // Only its empty status region stays mounted, so the outcome of a last decision can be announced.
        expect(screen.getByRole("status", { name: "Suggestion updates" }).textContent).toBe("");
    });

    it("shows an alert with a retry when the list cannot be read, and the list once a retry works", async () => {
        state.rows = [row("s1", "Weekly notes")];
        calls.failList = true;
        mountList();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("Failed to load the suggested tasks");

        calls.failList = false;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        expect(await screen.findByRole("button", { name: 'Accept "Weekly notes"' })).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows each suggestion with its schedule in words and buttons named after it", async () => {
        state.rows = [
            row("s1", "Weekly notes"),
            row("s2", "Morning plants", "30 8 * * 1-5"),
            row("s3", "Odd one", "0 9 1,15 * *"),
            row("s4", "Mid month", "0 9 15 * *"),
            row("s5", "Month end", "0 9 31 * *"),
        ];
        mountList();

        expect(await screen.findByRole("button", { name: 'Accept "Weekly notes"' })).toBeTruthy();
        expect(screen.getByRole("button", { name: 'Dismiss "Weekly notes"' })).toBeTruthy();
        expect(screen.getByRole("button", { name: 'Accept "Morning plants"' })).toBeTruthy();
        expect(screen.getAllByRole("listitem")).toHaveLength(5);
        expect(screen.getByText("Mondays at 09:00 UTC")).toBeTruthy();
        expect(screen.getByText("Weekdays at 08:30 UTC")).toBeTruthy();
        expect(screen.getByText("Repeats (0 9 1,15 * * UTC)")).toBeTruthy();
        expect(screen.getByText("Day 15 of every month at 09:00 UTC")).toBeTruthy();
        // The scheduler skips a month without the date: the words do not promise a run every month.
        expect(screen.getByText("Day 31 of the months that have one, at 09:00 UTC")).toBeTruthy();
    });

    it("clamps long instructions by default, and a button named after the suggestion shows and hides all of them", async () => {
        const long = `Check the inbox, then ${"summarise every thread and list the follow-ups. ".repeat(40)}Finish.`;

        state.rows = [{ ...row("s1", "Weekly notes"), instructions: long }, row("s2", "Morning plants")];
        mountList();

        const instructions = await screen.findByText(long);

        expect(instructions.className).toContain("line-clamp-2");

        const show = screen.getByRole("button", { name: 'Show all instructions for "Weekly notes"' });

        // A short suggestion fits its two lines, so it gets no toggle.
        expect(screen.queryByRole("button", { name: 'Show all instructions for "Morning plants"' })).toBeNull();
        expect(show.getAttribute("aria-controls")).toBe(instructions.id);

        fireEvent.click(show);

        expect(screen.getByText(long).className).not.toContain("line-clamp");
        expect(screen.getByText(long).className).toContain("whitespace-pre-wrap");
        expect(screen.getByText(long).textContent).toBe(long);

        fireEvent.click(screen.getByRole("button", { name: 'Show less of the instructions for "Weekly notes"' }));

        expect(screen.getByText(long).className).toContain("line-clamp-2");
        expect(screen.getByRole("button", { name: 'Show all instructions for "Weekly notes"' })).toBeTruthy();
    });

    it("takes a decided row off the list at once, and frees the buttons, while the live list has not caught up", async () => {
        state.live = false;
        state.rows = [row("s1", "Weekly notes"), row("s2", "Morning plants")];
        mountList();

        fireEvent.click(await screen.findByRole("button", { name: 'Dismiss "Weekly notes"' }));

        await waitFor(() => expect(screen.queryByRole("button", { name: 'Dismiss "Weekly notes"' })).toBeNull());
        expect(screen.getByRole("status", { name: "Suggestion updates" }).textContent).toBe("Suggestion dismissed: Weekly notes");

        // Not stuck: the next row can be decided, and the stale list answering again does not bring the first one back.
        const accept = screen.getByRole("button", { name: 'Accept "Morning plants"' });

        expect(accept.getAttribute("aria-disabled")).toBe("false");
        fireEvent.click(accept);
        await waitFor(() => expect(calls.accept).toEqual([{ suggestionId: "s2" }]));
        await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
        expect(screen.getByRole("status", { name: "Suggestion updates" }).textContent).toBe("Task created: Morning plants");
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

    it("leaves focus where the person put it when the last row leaves after they moved on", async () => {
        state.rows = [row("s1", "Weekly notes")];

        let release: () => void = () => undefined;

        // The web tsconfig's lib has no `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        calls.holdNext = new Promise<void>((resolve) => {
            release = resolve;
        });
        mountList();

        const dismiss = await screen.findByRole("button", { name: 'Dismiss "Weekly notes"' });

        dismiss.focus();
        fireEvent.click(dismiss);
        await waitFor(() => expect(calls.dismiss).toHaveLength(1));

        const elsewhere = screen.getByRole("button", { name: "New task" });

        elsewhere.focus();
        release();

        await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
        expect(hasFocus(elsewhere)).toBe(true);
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
