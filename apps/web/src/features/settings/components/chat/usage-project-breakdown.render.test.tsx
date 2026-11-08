import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import UsageProjectBreakdown from "./usage-project-breakdown";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/settings/hooks/use-usage-today", () => {
    return { useUsageToday: () => "2026-09-30" };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                usage: {
                    activity: {
                        getProjectBreakdown: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => {
                                        return {
                                            noProject: { costMicrodollars: 7, replies: 1, tokens: 1 },
                                            projects: [{ costMicrodollars: 140, projectKey: "p", replies: 2, title: "Alpha", tokens: 2 }],
                                            total: { costMicrodollars: 147, replies: 3, tokens: 3 },
                                            truncated: false,
                                        };
                                    },
                                    queryKey: ["breakdown", args],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("UsageProjectBreakdown", () => {
    it("shows the caller's breakdown per project, with No project", async () => {
        const { rerender } = render(<UsageProjectBreakdown backfilling days={30} />, { wrapper });

        // While the figures load, the card says so to screen readers.
        expect(screen.getByRole("status").textContent).toContain("Loading usage…");
        expect(await screen.findByText("Alpha")).toBeDefined();
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.getByText("No project")).toBeDefined();
        // Each row is headed by its project, and its spend meter names the project it measures.
        expect(screen.getByRole("rowheader", { name: "Alpha" })).toBeDefined();
        expect(screen.getByRole("meter", { name: "Alpha: 95% of spend" })).toBeDefined();

        // The backfill finishing reads the breakdown again.
        rerender(<UsageProjectBreakdown backfilling={false} days={30} />);
        expect(await screen.findByText("Alpha")).toBeDefined();
    });
});
