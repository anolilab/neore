/**
 * The retired list reads nothing until opened, says why and when each memory was retired, and "Bring back" makes one
 * current again: the list is read again from its first page, focus moves to the section's visible toggle, and a
 * failure is shown on the row.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RetiredMemoryData } from "./retired-memories";
import RetiredMemories from "./retired-memories";

const harness = vi.hoisted(() => {
    return {
        bringBack: vi.fn((_args: { memoryId: string }): Promise<null> => Promise.resolve(null)),
        listRequests: 0,
        /** What the server answers for each page, by its cursor (`first` for the first page). */
        pages: {} as Record<string, { continueCursor: string | null; isDone: boolean; page: RetiredMemoryData[] }>,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: {
                    date: (value: Date, format: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...format, timeZone: "UTC" }).format(value),
                },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                memory: {
                    retired: {
                        bringBackMemory: {
                            mutationOptions: () => {
                                return { mutationFn: harness.bringBack };
                            },
                        },
                        listRetiredMemories: {
                            queryKey: (args: unknown) => ["retired", args],
                            queryOptions: (args: { paginationOpts: { cursor: string | null } }) => {
                                return {
                                    queryFn: () => {
                                        harness.listRequests += 1;

                                        return Promise.resolve(harness.pages[args.paginationOpts.cursor ?? "first"]);
                                    },
                                    queryKey: ["retired", args],
                                    retry: false,
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const RETIRED_HEADING = "Retired memories";
const TEA: RetiredMemoryData = {
    _id: "m1",
    fromBot: false,
    memory: "Likes tea",
    replacesCurrent: true,
    retiredAt: Date.UTC(2026, 10, 20, 12),
    retiredReason: "revised",
    successor: "Likes green tea",
};
const COLD: RetiredMemoryData = { _id: "m2", fromBot: false, memory: "Has a cold", replacesCurrent: false, retiredAt: Date.UTC(2026, 10, 10, 12) };
const REPLACES_CURRENT = "Bring back (replaces the current version)";

const renderList = (onBroughtBack: () => void = vi.fn()): void => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });

    render(
        <QueryClientProvider client={client}>
            <RetiredMemories onBroughtBack={onBroughtBack} readCount={0} />
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    harness.listRequests = 0;
    harness.bringBack.mockReset();
    harness.bringBack.mockResolvedValue(null);
    harness.pages = { first: { continueCursor: null, isDone: true, page: [TEA, COLD] } };
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("RetiredMemories", () => {
    it("reads nothing until opened, then shows each memory with its reason, date and replacement", async () => {
        renderList();

        expect(harness.listRequests).toBe(0);

        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));

        expect(await screen.findByText("Likes tea")).toBeTruthy();
        expect(screen.getByText("Replaced by a newer version · Nov 20, 2026")).toBeTruthy();
        expect(screen.getByText("Now remembered as: Likes green tea")).toBeTruthy();
        expect(screen.getByText("Retired (reason not recorded) · Nov 10, 2026")).toBeTruthy();
        // Bringing back the revised one swaps it with the current version, and the button says so.
        expect(screen.getByRole("button", { name: REPLACES_CURRENT })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Bring back" })).toBeTruthy();
    });

    it("brings one back: the list is read again, focus moves to the section's toggle, and the current list is read again", async () => {
        const onBroughtBack = vi.fn();

        renderList(onBroughtBack);
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));

        const first = await screen.findByRole("button", { name: REPLACES_CURRENT });

        harness.pages = { first: { continueCursor: null, isDone: true, page: [COLD] } };
        fireEvent.click(first);

        await waitFor(() => {
            expect(screen.queryByText("Likes tea")).toBeNull();
        });

        expect(harness.bringBack.mock.calls[0]?.[0]).toStrictEqual({ memoryId: "m1" });
        expect(onBroughtBack).toHaveBeenCalledTimes(1);
        // eslint-disable-next-line testing-library/no-node-access -- where focus lands after the row leaves is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("button", { name: RETIRED_HEADING }));
        expect(await screen.findByText("Has a cold")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe("Memory brought back.");
    });

    it("shows a memory brought back and retired again since, as the server lists it", async () => {
        renderList();
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));
        fireEvent.click(await screen.findByRole("button", { name: REPLACES_CURRENT }));

        await waitFor(() => {
            expect(harness.listRequests).toBe(2);
        });

        expect(await screen.findByText("Likes tea")).toBeTruthy();
    });

    it("starts paging over from the first page after a bring-back, so no row is skipped or repeated", async () => {
        harness.pages = {
            c1: { continueCursor: null, isDone: true, page: [COLD] },
            first: { continueCursor: "c1", isDone: false, page: [TEA] },
        };
        renderList();
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));
        fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
        await screen.findByText("Has a cold");

        // The row moved up a page once Tea left the list.
        harness.pages = { first: { continueCursor: null, isDone: true, page: [COLD] } };
        fireEvent.click(screen.getByRole("button", { name: REPLACES_CURRENT }));

        await waitFor(() => {
            expect(screen.queryByText("Likes tea")).toBeNull();
        });

        expect(await screen.findAllByText("Has a cold")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    });

    it("reads the open list again after a change elsewhere on the page", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const view = render(
            <QueryClientProvider client={client}>
                <RetiredMemories onBroughtBack={vi.fn()} readCount={0} />
            </QueryClientProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));
        await screen.findByText("Likes tea");
        harness.pages = { first: { continueCursor: null, isDone: true, page: [] } };
        view.rerender(
            <QueryClientProvider client={client}>
                <RetiredMemories onBroughtBack={vi.fn()} readCount={1} />
            </QueryClientProvider>,
        );

        expect(await screen.findByText("No retired memories.")).toBeTruthy();
        expect(harness.listRequests).toBe(2);
    });

    it("keeps the row and says so when bringing it back fails", async () => {
        harness.bringBack.mockRejectedValue(new Error("rate limited"));
        const onBroughtBack = vi.fn();

        renderList(onBroughtBack);
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));

        const first = await screen.findByRole("button", { name: REPLACES_CURRENT });

        fireEvent.click(first);

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("This memory could not be brought back. Please try again in a moment.");
        expect(screen.getByText("Likes tea")).toBeTruthy();
        expect(onBroughtBack).not.toHaveBeenCalled();
    });
});
