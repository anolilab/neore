/**
 * The retired list reads nothing until opened, says why and when each memory was retired, and "Bring back" makes one
 * current again: the row leaves the list, focus moves to the section, and a failure is shown on the row.
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
        page: [] as RetiredMemoryData[],
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
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: () => {
                                        harness.listRequests += 1;

                                        return Promise.resolve({ continueCursor: null, isDone: true, page: harness.page });
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

const renderList = (onBroughtBack: () => void = vi.fn()): void => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });

    render(
        <QueryClientProvider client={client}>
            <RetiredMemories onBroughtBack={onBroughtBack} />
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    harness.listRequests = 0;
    harness.bringBack.mockReset();
    harness.bringBack.mockResolvedValue(null);
    harness.page = [
        { _id: "m1", fromBot: false, memory: "Likes tea", retiredAt: Date.UTC(2026, 10, 20, 12), retiredReason: "revised", successor: "Likes green tea" },
        { _id: "m2", fromBot: false, memory: "Has a cold", retiredAt: Date.UTC(2026, 10, 10, 12) },
    ];
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
        expect(screen.getAllByRole("button", { name: "Bring back" })).toHaveLength(2);
    });

    it("brings one back: the row leaves the list, focus moves to the section, and the current list is read again", async () => {
        const onBroughtBack = vi.fn();

        renderList(onBroughtBack);
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));

        const [first] = await screen.findAllByRole("button", { name: "Bring back" });

        fireEvent.click(first!);

        await waitFor(() => {
            expect(screen.queryByText("Likes tea")).toBeNull();
        });

        expect(harness.bringBack.mock.calls[0]?.[0]).toStrictEqual({ memoryId: "m1" });
        expect(onBroughtBack).toHaveBeenCalledTimes(1);
        // eslint-disable-next-line testing-library/no-node-access -- where focus lands after the row leaves is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("heading", { name: RETIRED_HEADING }));
        expect(screen.getByRole("status").textContent).toBe("Memory brought back.");
        expect(screen.getByText("Has a cold")).toBeTruthy();
    });

    it("keeps the row and says so when bringing it back fails", async () => {
        harness.bringBack.mockRejectedValue(new Error("rate limited"));
        const onBroughtBack = vi.fn();

        renderList(onBroughtBack);
        fireEvent.click(screen.getByRole("button", { name: RETIRED_HEADING }));

        const [first] = await screen.findAllByRole("button", { name: "Bring back" });

        fireEvent.click(first!);

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("This memory could not be brought back. Please try again in a moment.");
        expect(screen.getByText("Likes tea")).toBeTruthy();
        expect(onBroughtBack).not.toHaveBeenCalled();
    });
});
