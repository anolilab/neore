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

const { fetchOrganization, permission, permissionAsked } = vi.hoisted(() => {
    return { fetchOrganization: vi.fn(), permission: { success: false }, permissionAsked: [] as unknown[] };
});

vi.mock("@neore/backend/api", () => {
    return { api: { usage: { organization: { getOrganizationProjectUsage: "getOrganizationProjectUsage" } } } };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: {} };
        },
    };
});

vi.mock("@/features/auth/hooks/session-user-management", () => {
    return {
        useSession: () => {
            return { data: { user: { id: "user-1" } } };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { data: { id: "org_1" } };
        },
        useHasPermission: (_client: unknown, parameters: unknown) => {
            permissionAsked.push(parameters);

            return { data: permission };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: () => fetchOrganization,
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
    it("shows a plain member their own breakdown, with No project, and never asks for the organization's", async () => {
        const { rerender } = render(<UsageProjectBreakdown backfilling days={30} />, { wrapper });

        // While the figures load, the card says so to screen readers.
        expect(screen.getByRole("status").textContent).toContain("Loading usage…");
        expect(await screen.findByText("Alpha")).toBeDefined();
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.getByText("No project")).toBeDefined();
        expect(screen.queryByRole("group", { name: "Whose usage" })).toBeNull();

        // The backfill finishing reads the breakdown again; the organization read is not this member's to make.
        rerender(<UsageProjectBreakdown backfilling={false} days={30} />);
        await screen.findByText("Alpha");

        expect(fetchOrganization).not.toHaveBeenCalled();
        // The role is asked about the active organization, so a cached answer from another one is never reused.
        expect(permissionAsked.at(-1)).toMatchObject({ organizationId: "org_1" });
    });

    it("leaves an admin on their own view without an organization read until they switch to it", async () => {
        permission.success = true;

        const { rerender } = render(<UsageProjectBreakdown backfilling days={30} />, { wrapper });

        await screen.findByText("Alpha");
        rerender(<UsageProjectBreakdown backfilling={false} days={30} />);
        await screen.findByText("Alpha");

        expect(fetchOrganization).not.toHaveBeenCalled();
        permission.success = false;
    });
});
