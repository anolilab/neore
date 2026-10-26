/**
 * `useCheckout`: Creem checkout and portal calls end in a full-page redirect to
 * the hosted URL; a refusal becomes a toast and frees the buttons again.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        createCheckout: vi.fn(),
        openCustomerPortal: vi.fn(),
        toastError: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { billing: { checkout: { createCheckout: "createCheckout", openCustomerPortal: "openCustomerPortal" } } } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: (reference: string) => (reference === "createCheckout" ? harness.createCheckout : harness.openCustomerPortal),
    };
});

vi.mock("sonner", () => {
    return { toast: { error: harness.toastError } };
});

const { default: useCheckout } = await import("./use-checkout");

const assign = vi.fn();

beforeEach(() => {
    vi.stubGlobal("location", { assign });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("useCheckout", () => {
    it("starts a monthly checkout by default and redirects to the hosted URL", async () => {
        harness.createCheckout.mockResolvedValue({ url: "https://pay.test/checkout/1" });
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.startCheckout("pro");
        });

        expect(harness.createCheckout).toHaveBeenCalledWith({ interval: "month", plan: "pro" });
        expect(assign).toHaveBeenCalledWith("https://pay.test/checkout/1");
        expect(harness.toastError).not.toHaveBeenCalled();
    });

    it("passes the chosen plan and interval through", async () => {
        harness.createCheckout.mockResolvedValue({ url: "https://pay.test/checkout/2" });
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.startCheckout("team", "year");
        });

        expect(harness.createCheckout).toHaveBeenCalledWith({ interval: "year", plan: "team" });
    });

    it("opens the customer portal for the requested subject", async () => {
        harness.openCustomerPortal.mockResolvedValue({ url: "https://pay.test/portal" });
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.openPortal("organization");
        });

        expect(harness.openCustomerPortal).toHaveBeenCalledWith({ subject: "organization" });
        expect(assign).toHaveBeenCalledWith("https://pay.test/portal");
    });

    it("stays pending after a successful call, because the page is about to be left", async () => {
        harness.createCheckout.mockResolvedValue({ url: "https://pay.test/checkout/3" });
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.startCheckout("pro");
        });

        expect(result.current.isPending).toBe(true);
    });

    it("turns a refusal into a localized toast, does not redirect, and frees the buttons", async () => {
        harness.createCheckout.mockRejectedValue({ error: { code: "ALREADY_SUBSCRIBED_PLAN" } });
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.startCheckout("pro");
        });

        expect(harness.toastError).toHaveBeenCalledWith("You're already subscribed to this plan");
        expect(assign).not.toHaveBeenCalled();
        expect(result.current.isPending).toBe(false);
    });

    it("falls back to the error message for a failure without a code", async () => {
        harness.openCustomerPortal.mockRejectedValue(new Error("Billing is not configured"));
        const { result } = renderHook(() => useCheckout());

        await act(async () => {
            await result.current.openPortal("user");
        });

        expect(harness.toastError).toHaveBeenCalledWith("Billing is not configured");
        expect(assign).not.toHaveBeenCalled();
    });

    it("shows the limit message with an Upgrade action that starts a Pro checkout", async () => {
        harness.createCheckout.mockResolvedValue({ url: "https://pay.test/checkout/4" });
        const { result } = renderHook(() => useCheckout());

        act(() => {
            result.current.upgradeToast("Daily limit reached");
        });

        expect(harness.toastError).toHaveBeenCalledTimes(1);

        const [message, options] = harness.toastError.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];

        expect(message).toBe("Daily limit reached");
        expect(options.action.label).toBe("Upgrade");

        await act(async () => {
            options.action.onClick();
        });

        expect(harness.createCheckout).toHaveBeenCalledWith({ interval: "month", plan: "pro" });
    });
});
