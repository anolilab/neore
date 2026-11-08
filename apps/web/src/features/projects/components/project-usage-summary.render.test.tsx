import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectUsageSummary from "./project-usage-summary";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/settings/hooks/use-usage-today", () => {
    return {
        useUsageToday: () => {
            return { failed: false, today: "2026-09-30" };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                usage: {
                    activity: {
                        getProjectUsage: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => {
                                        return { costMicrodollars: 1_500_000, replies: 3, tokens: 1200, truncated: false };
                                    },
                                    queryKey: ["project-usage", args],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

describe("ProjectUsageSummary", () => {
    it("titles its section with a heading that screen readers can jump to", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <ProjectUsageSummary projectId="project-1" />
            </QueryClientProvider>,
        );

        const heading = screen.getByRole("heading", { level: 3, name: "Usage" });

        expect(screen.getByRole("region", { name: "Usage" }).contains(heading)).toBe(true);
        expect(await screen.findByText("3")).toBeDefined();
    });
});
