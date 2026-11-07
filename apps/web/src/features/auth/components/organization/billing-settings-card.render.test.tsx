/**
 * `<BillingSettingsCard>`: every member sees the organization's real tier and credit
 * allowance, only an owner gets the billing form, and the organization's plan buttons
 * start a Team checkout or open the Creem portal for the organization.
 */

import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        billingError: false,
        billingInfo: undefined as { baseTier?: string; creditsPerUser?: number; creemSubscriptionId?: string } | undefined,
        isOwner: false,
        openPortal: vi.fn(),
        startCheckout: vi.fn(),
        toast: vi.fn(),
        updateBillingSettings: vi.fn(),
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
            return { authClient: {}, toast: harness.toast };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { data: { id: "org_1" }, isPending: false };
        },
    };
});

vi.mock("@/features/billing/hooks/use-checkout", () => {
    return {
        default: () => {
            return { isPending: false, openPortal: harness.openPortal, startCheckout: harness.startCheckout };
        },
    };
});

vi.mock("@/features/billing/hooks/use-billing-options", () => {
    return {
        default: () => {
            return { yearly: { pro: false, team: false } };
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
                            // A `skipToken` argument leaves the query idle, as TanStack Query does, so a member test fails if the read is skipped.
                            queryOptions: (input: unknown) => {
                                return {
                                    queryFn:
                                        input === skipToken
                                            ? skipToken
                                            : async () => {
                                                  if (harness.billingError) {
                                                      throw new Error("billing unavailable");
                                                  }

                                                  // The server reports the viewer's ownership with the read; the test drives it through `isOwner`.
                                                  return harness.billingInfo ? { isOwner: harness.isOwner, ...harness.billingInfo } : null;
                                              },
                                    queryKey: ["billing-info"],
                                };
                            },
                        },
                        updateBillingSettings: {
                            mutationOptions: () => {
                                return { mutationFn: harness.updateBillingSettings };
                            },
                        },
                    },
                },
            };
        },
    };
});

const { default: BillingSettingsCard } = await import("./billing-settings-card");

const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return { queryClient, ...render(createElement(QueryClientProvider, { client: queryClient }, createElement(BillingSettingsCard))) };
};

afterEach(() => {
    harness.billingError = false;
    harness.billingInfo = undefined;
    harness.isOwner = false;
    vi.clearAllMocks();
});

describe("BillingSettingsCard", () => {
    it("shows a member the organization's actual tier and credit allowance, read-only, with no billing form to save", async () => {
        harness.isOwner = false;
        harness.billingInfo = { baseTier: "enterprise", creditsPerUser: 500 };
        mount();

        expect(await screen.findByText("enterprise")).toBeTruthy();
        expect(screen.getByText("500")).toBeTruthy();
        expect(screen.queryByText("free")).toBeNull();
        expect(screen.queryByText("100")).toBeNull();
        expect(screen.getByText("Only organization owners can manage billing settings")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        expect(screen.queryByLabelText("Billing Email")).toBeNull();
        expect(screen.queryByRole("button", { name: "Upgrade organization to Team" })).toBeNull();
    });

    it("shows an organization admin the read-only plan, with no billing form to save", async () => {
        // Admins hold the organization-update permission too, so ownership is the server's `isOwner`, not that permission.
        harness.isOwner = false;
        harness.billingInfo = { baseTier: "pro", creditsPerUser: 1000 };
        mount();

        expect(await screen.findByText("pro")).toBeTruthy();
        expect(screen.getByText("1000")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        expect(screen.queryByLabelText("Billing Email")).toBeNull();
    });

    it("shows the error, not the earlier plan, when a refetch after an organization switch fails", async () => {
        harness.isOwner = false;
        harness.billingInfo = { baseTier: "enterprise", creditsPerUser: 500 };
        const { queryClient } = mount();

        expect(await screen.findByText("enterprise")).toBeTruthy();

        harness.billingError = true;
        await queryClient.invalidateQueries({ queryKey: ["billing-info"] });

        expect(await screen.findByText("Could not load your organization's billing details. Try again later.")).toBeTruthy();
        expect(screen.queryByText("enterprise")).toBeNull();
        expect(screen.queryByText("500")).toBeNull();
    });

    it("offers an owner of a Free organization the Team upgrade, which starts a Team checkout", async () => {
        const user = userEvent.setup();

        harness.isOwner = true;
        harness.billingInfo = { baseTier: "free" };
        mount();

        await user.click(await screen.findByRole("button", { name: "Upgrade organization to Team" }));

        expect(harness.startCheckout).toHaveBeenCalledWith("team");
        expect(screen.queryByRole("button", { name: "Manage Team subscription" })).toBeNull();
    });

    it("opens the organization portal for an owner whose Team subscription is on Creem", async () => {
        const user = userEvent.setup();

        harness.isOwner = true;
        harness.billingInfo = { baseTier: "enterprise", creemSubscriptionId: "sub_1" };
        mount();

        await user.click(await screen.findByRole("button", { name: "Manage Team subscription" }));

        expect(harness.openPortal).toHaveBeenCalledWith("organization");
        expect(screen.queryByRole("button", { name: "Upgrade organization to Team" })).toBeNull();
    });

    it("saves the billing email the owner typed", async () => {
        const user = userEvent.setup();

        harness.isOwner = true;
        harness.billingInfo = { baseTier: "free" };
        harness.updateBillingSettings.mockResolvedValue({});
        mount();

        // The field is found by its label, so this also checks that the label is linked to the input.
        await user.type(await screen.findByLabelText("Billing Email"), "billing@acme.test");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(harness.updateBillingSettings).toHaveBeenCalledTimes(1);
        });
        expect(harness.updateBillingSettings.mock.calls[0]?.[0]).toMatchObject({ billingEmail: "billing@acme.test" });
        expect(harness.toast).toHaveBeenCalledWith({ message: "Billing settings updated successfully", variant: "success" });
    });

    it("shows a member that the organization's billing could not be read, not the Free plan", async () => {
        harness.isOwner = false;
        harness.billingError = true;
        mount();

        expect(await screen.findByText("Could not load your organization's billing details. Try again later.")).toBeTruthy();
        expect(screen.queryByText("free")).toBeNull();
        expect(screen.queryByText("100")).toBeNull();
    });

    it("gives an owner no plan buttons or Save when the organization's billing could not be read", async () => {
        harness.isOwner = true;
        harness.billingError = true;
        mount();

        expect(await screen.findByText("Could not load your organization's billing details. Try again later.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Upgrade organization to Team" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });
});
