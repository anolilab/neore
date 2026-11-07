/**
 * `<CreateOrganizationDialog>`: creating an organization makes it the active one and drops
 * the cached billing read, so the next read is the new organization's plan.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        create: vi.fn(),
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
                authClient: { organization: { create: harness.create, setActive: harness.setActive } },
                organization: null,
                toast: harness.toast,
            };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { refetch: async () => undefined };
        },
        useListOrganizations: () => {
            return { refetch: async () => undefined };
        },
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
                    organization: {
                        checkSlug: {
                            queryOptions: (input: { slug: string }) => {
                                return {
                                    queryFn: async () => {
                                        return { available: input.slug !== "taken" };
                                    },
                                    queryKey: ["check-slug", input.slug],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const { default: CreateOrganizationDialog } = await import("./create-organization-dialog");

afterEach(() => {
    vi.clearAllMocks();
});

describe("CreateOrganizationDialog", () => {
    it("creates the organization, makes it active, and drops the cached billing read", async () => {
        const user = userEvent.setup();

        harness.create.mockResolvedValue({ id: "org_new" });
        harness.setActive.mockResolvedValue({});

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        queryClient.setQueryData(["billing-info"], { baseTier: "enterprise", creditsPerUser: 10_000 });

        render(
            <QueryClientProvider client={queryClient}>
                <CreateOrganizationDialog onOpenChange={vi.fn()} open />
            </QueryClientProvider>,
        );

        // The shared form does not link its labels to the inputs, so the fields are found by placeholder.
        await user.type(screen.getByPlaceholderText("Enter organization name"), "Beta Co");
        await user.type(screen.getByPlaceholderText("Enter organization slug"), "beta-co");

        // The slug check is debounced, then the create button stays disabled until the slug reports available.
        await screen.findByText("This slug is available", {}, { timeout: 3000 });
        await user.click(screen.getByRole("button", { name: "Create Organization" }));

        await waitFor(() => {
            expect(harness.setActive).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_new" }));
        });
        expect(queryClient.getQueryState(["billing-info"])?.isInvalidated).toBe(true);
    });
});
