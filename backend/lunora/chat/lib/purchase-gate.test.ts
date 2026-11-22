import { describe, expect, it, vi } from "vitest";

import { browserActionNeedsPurchaseApproval, isPurchaseText } from "./purchase-gate";

describe("isPurchaseText", () => {
    it.each([
        "Pay now",
        "Buy now",
        "Place order",
        "Place your order",
        "Checkout",
        "Complete purchase",
        "Confirm order",
        "Jetzt kaufen",
        "Bezahlen",
        "Zahlungspflichtig bestellen",
    ])("reads %s as a purchase", (text) => {
        expect(isPurchaseText(text)).toBe(true);
    });

    it.each(["Payroll", "Buyers guide", "Next page", "Sort by order", "Order history", "Search", "Continue", "Payment settings"])(
        "does not read %s as a purchase",
        (text) => {
            expect(isPurchaseText(text)).toBe(false);
        },
    );
});

describe("the purchase gate on browser actions", () => {
    it("asks nothing for a non-click, and reads nothing", async () => {
        const look = vi.fn();

        expect(await browserActionNeedsPurchaseApproval({ action: "navigate" }, look)).toBe(false);
        expect(await browserActionNeedsPurchaseApproval({ action: "type", selector: "#card" }, look)).toBe(false);
        expect(look).not.toHaveBeenCalled();
    });

    it("asks nothing for a click with no selector", async () => {
        const look = vi.fn();

        expect(await browserActionNeedsPurchaseApproval({ action: "click" }, look)).toBe(false);
        expect(look).not.toHaveBeenCalled();
    });

    it("asks for a click on a purchase target, reading the same selector", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "Pay now", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#pay" }, look)).toBe(true);
        expect(look).toHaveBeenCalledWith("#pay");
    });

    it("does not ask for a click on an ordinary target", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "Next", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: ".next" }, look)).toBe(false);
    });

    it("asks for an element with no readable text, whatever its selector", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "  ", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#checkout" }, look)).toBe(true);
        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#menu" }, look)).toBe(true);
    });

    it("asks when the target cannot be read", async () => {
        const failed = vi.fn(() => Promise.resolve({ success: false }));
        const thrown = vi.fn(async () => {
            throw new Error("renderer unreachable");
        });

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, failed)).toBe(true);
        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, thrown)).toBe(true);
    });
});
