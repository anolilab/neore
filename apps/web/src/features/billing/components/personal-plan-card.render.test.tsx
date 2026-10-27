/** The personal plan card: what a Free and a Pro user can do, and what each button starts. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const UPGRADE_TO_PRO = /Upgrade to Pro/;

const harness = vi.hoisted(() => {
    return {
        checkoutPending: false,
        openPortal: vi.fn(),
        plan: undefined as { baseTier?: string; creemCustomerId?: string } | undefined,
        planPending: false,
        startCheckout: vi.fn(),
        yearlyPro: false,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                billing: {
                    checkout: {
                        getMyPlan: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        if (harness.planPending) {
                                            return await new Promise(() => {});
                                        }

                                        return harness.plan ?? null;
                                    },
                                    queryKey: ["my-plan", harness.plan, harness.planPending],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("../hooks/use-checkout", () => {
    return {
        default: () => {
            return { isPending: harness.checkoutPending, openPortal: harness.openPortal, startCheckout: harness.startCheckout };
        },
    };
});

vi.mock("../hooks/use-billing-options", () => {
    return {
        default: () => {
            return { yearly: { pro: harness.yearlyPro, team: false } };
        },
    };
});

const { default: PersonalPlanCard } = await import("./personal-plan-card");

const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(PersonalPlanCard)));
};

afterEach(() => {
    harness.checkoutPending = false;
    harness.plan = undefined;
    harness.planPending = false;
    harness.yearlyPro = false;
    vi.clearAllMocks();
});

describe("PersonalPlanCard", () => {
    it("shows a Free user the plan and a single upgrade button", async () => {
        harness.plan = { baseTier: "free" };
        mount();

        expect(await screen.findByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
        expect(screen.getByText("Free")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Pay yearly" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
    });

    it("starts a monthly Pro checkout from the upgrade button", async () => {
        harness.plan = { baseTier: "free" };
        mount();

        fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));

        expect(harness.startCheckout).toHaveBeenCalledWith("pro");
    });

    it("offers a yearly checkout when the plan can be bought yearly, and labels the other button monthly", async () => {
        harness.plan = { baseTier: "free" };
        harness.yearlyPro = true;
        mount();

        expect(await screen.findByRole("button", { name: "Upgrade to Pro, monthly" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Pay yearly" }));

        expect(harness.startCheckout).toHaveBeenCalledWith("pro", "year");
    });

    it("shows a Pro user the portal, never an upgrade", async () => {
        harness.plan = { baseTier: "pro", creemCustomerId: "cust_1" };
        mount();

        expect(await screen.findByText("Pro")).toBeTruthy();
        expect(screen.queryByRole("button", { name: UPGRADE_TO_PRO })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));

        expect(harness.openPortal).toHaveBeenCalledWith("user");
    });

    it("offers the portal to a Free user who has been a customer before", async () => {
        harness.plan = { baseTier: "free", creemCustomerId: "cust_1" };
        mount();

        expect(await screen.findByRole("button", { name: "Manage subscription" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
    });

    it("disables every billing button while a checkout is in flight", async () => {
        harness.plan = { baseTier: "free", creemCustomerId: "cust_1" };
        harness.yearlyPro = true;
        harness.checkoutPending = true;
        mount();

        await screen.findByRole("button", { name: "Manage subscription" });

        for (const name of ["Manage subscription", "Pay yearly", "Upgrade to Pro, monthly"]) {
            expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
        }
    });

    it("offers no upgrade before the plan has loaded", () => {
        harness.planPending = true;
        mount();

        expect(screen.queryByRole("button", { name: UPGRADE_TO_PRO })).toBeNull();
    });
});
