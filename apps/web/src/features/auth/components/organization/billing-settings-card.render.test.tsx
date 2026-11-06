/**
 * `<BillingSettingsCard>`: only an owner gets the billing form, and the organization's
 * plan buttons start a Team checkout or open the Creem portal for the organization.
 */

import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        billingInfo: undefined as { baseTier?: string; creemSubscriptionId?: string } | undefined,
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
        useHasPermission: () => {
            return { data: { success: harness.isOwner }, isPending: false };
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
                            // A non-owner's query is `skipToken`: it must never run, so the card cannot read the plan.
                            queryOptions: (arguments_: unknown) => {
                                return {
                                    queryFn: arguments_ === skipToken ? skipToken : async () => harness.billingInfo ?? null,
                                    queryKey: ["billing-info", arguments_ === skipToken ? "skipped" : "owner"],
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

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(BillingSettingsCard)));
};

afterEach(() => {
    harness.billingInfo = undefined;
    harness.isOwner = false;
    vi.clearAllMocks();
});

describe("BillingSettingsCard", () => {
    it("shows a member the tier read-only, with no billing form to save", async () => {
        harness.isOwner = false;
        mount();

        expect(await screen.findByText("Only organization owners can manage billing settings")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        expect(screen.queryByPlaceholderText("Enter billing email")).toBeNull();
        expect(screen.queryByRole("button", { name: "Upgrade organization to Team" })).toBeNull();
    });

    it("offers an owner of a Free organization the Team upgrade, which starts a Team checkout", async () => {
        harness.isOwner = true;
        harness.billingInfo = { baseTier: "free" };
        mount();

        fireEvent.click(await screen.findByRole("button", { name: "Upgrade organization to Team" }));

        expect(harness.startCheckout).toHaveBeenCalledWith("team");
        expect(screen.queryByRole("button", { name: "Manage Team subscription" })).toBeNull();
    });

    it("opens the organization portal for an owner whose Team subscription is on Creem", async () => {
        harness.isOwner = true;
        harness.billingInfo = { baseTier: "team", creemSubscriptionId: "sub_1" };
        mount();

        fireEvent.click(await screen.findByRole("button", { name: "Manage Team subscription" }));

        expect(harness.openPortal).toHaveBeenCalledWith("organization");
        expect(screen.queryByRole("button", { name: "Upgrade organization to Team" })).toBeNull();
    });

    it("saves the billing email the owner typed", async () => {
        harness.isOwner = true;
        harness.billingInfo = { baseTier: "free" };
        harness.updateBillingSettings.mockResolvedValue({});
        mount();

        fireEvent.change(await screen.findByPlaceholderText("Enter billing email"), { target: { value: "billing@acme.test" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(harness.updateBillingSettings).toHaveBeenCalledTimes(1);
        });
        expect(harness.updateBillingSettings.mock.calls[0]?.[0]).toMatchObject({ billingEmail: "billing@acme.test" });
        expect(harness.toast).toHaveBeenCalledWith({ message: "Billing settings updated successfully", variant: "success" });
    });
});
