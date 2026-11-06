/**
 * `<BillingSettingsCard>`: every member sees the organization's real tier and credit
 * allowance, only an owner gets the billing form, and the organization's plan buttons
 * start a Team checkout or open the Creem portal for the organization.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
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
                            queryOptions: () => {
                                return {
                                    queryFn: async () => harness.billingInfo ?? null,
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

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(BillingSettingsCard)));
};

afterEach(() => {
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
        harness.billingInfo = { baseTier: "enterprise", creemSubscriptionId: "sub_1" };
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

        // The shared form control does not link its label to the input (see sign-in-form.render.test.tsx), so find it by placeholder.
        fireEvent.change(await screen.findByPlaceholderText("Enter billing email"), { target: { value: "billing@acme.test" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(harness.updateBillingSettings).toHaveBeenCalledTimes(1);
        });
        expect(harness.updateBillingSettings.mock.calls[0]?.[0]).toMatchObject({ billingEmail: "billing@acme.test" });
        expect(harness.toast).toHaveBeenCalledWith({ message: "Billing settings updated successfully", variant: "success" });
    });
});
