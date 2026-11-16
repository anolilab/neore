/**
 * `<OrganizationCell>`: "Manage Organization" on a non-active organization makes it the
 * active one, and drops the cached billing read so the next read is the new organization's.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        navigate: vi.fn(),
        setActive: vi.fn(),
        toast: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: { organization: { setActive: harness.setActive } },
                basePath: "/settings",
                navigate: harness.navigate,
                settings: undefined,
                toast: harness.toast,
                viewPaths: { ORGANIZATION: "organization" },
            };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { data: { id: "org_a", name: "Acme" }, refetch: async () => undefined };
        },
    };
});

vi.mock("./leave-organization-dialog", () => {
    return {
        default: () => null,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    billing: {
                        getBillingInfo: {
                            queryKey: () => ["billing-info"],
                        },
                    },
                },
            };
        },
    };
});

const { default: OrganizationCell } = await import("./organization-cell");

// The ellipsis menu positions itself with floating-ui, which observes its anchor; jsdom has no ResizeObserver.
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("OrganizationCell", () => {
    it("makes a non-active organization active and drops the cached billing read", async () => {
        const user = userEvent.setup();

        harness.setActive.mockResolvedValue({});

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        queryClient.setQueryData(["billing-info"], { baseTier: "enterprise", creditsPerUser: 10_000 });

        const organization = { createdAt: new Date(), id: "org_b", logo: null, name: "Beta", slug: "beta" };

        render(
            <QueryClientProvider client={queryClient}>
                <OrganizationCell organization={organization as never} />
            </QueryClientProvider>,
        );

        // The ellipsis menu is the cell's only button.
        await user.click(screen.getByRole("button"));
        await user.click(await screen.findByRole("menuitem", { name: "Manage Organization" }));

        await waitFor(() => {
            expect(queryClient.getQueryData(["billing-info"])).toBeUndefined();
        });
        expect(harness.setActive).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_b" }));
    });
});
