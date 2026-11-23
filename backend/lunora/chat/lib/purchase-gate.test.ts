import { describe, expect, it, vi } from "vitest";

import { approvalMessagesFor } from "../../agent/client/tool-approval";
import { approvedToolCallIds, browserActionNeedsPurchaseApproval, isPurchaseText, purchaseTargetNeedsApproval } from "./purchase-gate";

describe("a checkout's subscribe control", () => {
    it("asks on a checkout, and an ordinary newsletter subscribe does not", () => {
        const subscribe = { content: "Subscribe", label: "Subscribe", success: true, target: "t" };

        expect(purchaseTargetNeedsApproval({ ...subscribe, checkout: true })).toBe(true);
        expect(purchaseTargetNeedsApproval({ ...subscribe, checkout: false })).toBe(false);
    });
});

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
        "Submit order",
        "Confirm payment",
        "Submit payment",
        "Proceed to payment",
        "Jetzt zahlen",
        "Bestellung aufgeben",
        "Kauf abschließen",
        "Zur Kasse",
        "Place\norder",
        "Place order",
        "Bestellen",
    ])("reads %s as a purchase", (text) => {
        expect(isPurchaseText(text)).toBe(true);
    });

    it.each([
        "Payroll",
        "Buyers guide",
        "Next page",
        "Sort by order",
        "Order history",
        "Search",
        "Continue",
        "Payment settings",
        "Bestellungen",
        "Kaufbedingungen",
        "Kaufhaus",
        "Zahlungsarten",
    ])("does not read %s as a purchase", (text) => {
        expect(isPurchaseText(text)).toBe(false);
    });
});

describe("approvedToolCallIds", () => {
    const request = (approvalId: string, toolCallId: string) => {
        return {
            content: [{ approvalId, toolCallId, type: "tool-approval-request" }],
            role: "assistant",
        };
    };
    const response = (approvalId: string, approved: boolean) => {
        return {
            content: [{ approvalId, approved, type: "tool-approval-response" }],
            role: "tool",
        };
    };

    it("names the calls whose approval was answered yes", () => {
        const messages = [{ content: "hi", role: "user" }, request("a-1", "call-1"), request("a-2", "call-2"), response("a-1", true), response("a-2", false)];

        expect([...approvedToolCallIds(messages)]).toEqual(["call-1"]);
    });

    it("names nothing for an approval that was never answered, or whose request is not in the messages", () => {
        expect(approvedToolCallIds([request("a-1", "call-1")])).toEqual(new Set());
        expect(approvedToolCallIds([response("a-9", true)])).toEqual(new Set());
        expect(approvedToolCallIds([{ content: "text", role: "user" }, null, 3])).toEqual(new Set());
    });
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

    it("asks for a bare submit-like label on a checkout, and not elsewhere", async () => {
        const onCheckout = vi.fn(() => Promise.resolve({ checkout: true, content: "Confirm", success: true }));
        const elsewhere = vi.fn(() => Promise.resolve({ content: "Confirm", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#go" }, onCheckout)).toBe(true);
        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#go" }, elsewhere)).toBe(false);
    });

    it("asks for a checkout control whose joined name hides a bare submit word as one of its parts", async () => {
        const combined = vi.fn(() => Promise.resolve({ checkout: true, content: "", label: "Continue shopping Confirm", submitLike: true, success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#icon" }, combined)).toBe(true);
    });

    it("does not ask for a checkout's navigation link that only starts with a submit word", async () => {
        const shopping = vi.fn(() => Promise.resolve({ checkout: true, content: "Continue shopping", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#back" }, shopping)).toBe(false);
    });

    it("does not ask for an ordinary control with no text but an ordinary name", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "", label: "Next", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, look)).toBe(false);
    });

    it("asks when the target cannot be read", async () => {
        const failed = vi.fn(() => Promise.resolve({ success: false }));
        const thrown = vi.fn(async () => {
            throw new Error("renderer unreachable");
        });

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, failed)).toBe(true);
        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, thrown)).toBe(true);
    });

    it("asks for a control whose accessible name is a purchase, though its visible text is not", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "→", label: "Buy now", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#go" }, look)).toBe(true);
    });

    it("does not ask for an ordinary control whose name is ordinary too", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "→", label: "Next page", success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#go" }, look)).toBe(false);
    });

    it("asks when the accessible name was cut short, since a purchase word may sit past the cut", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "→", label: "Next", labelTruncated: true, success: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#go" }, look)).toBe(true);
    });

    it("asks for a truncated read, since a purchase word may sit past the cut", async () => {
        const look = vi.fn(() => Promise.resolve({ content: "Next", success: true, truncated: true }));

        expect(await browserActionNeedsPurchaseApproval({ action: "click", selector: "#next" }, look)).toBe(true);
    });
});

describe("the approval an approved tool call runs with", () => {
    it("is read as approved for that call", () => {
        expect([...approvedToolCallIds(approvalMessagesFor("approval-7", "call-7"))]).toEqual(["call-7"]);
    });
});

describe("a selector that matches nothing", () => {
    it("asks nothing: the click fails at once", async () => {
        const missing = vi.fn(async () => {
            return { error: "Element not found: #gone", success: false, target: undefined };
        });

        await expect(browserActionNeedsPurchaseApproval({ action: "click", selector: "#gone" }, missing)).resolves.toBe(false);
    });
});

describe("isPurchaseText for ordinary link text", () => {
    it.each(["Check out our new arrivals", "Zahlen & Fakten", "Zahlen", "Read the payroll report"])("does not read %j as a purchase", (text) => {
        expect(isPurchaseText(text)).toBe(false);
    });

    it.each(["Jetzt zahlen", "Jetzt bezahlen", "Checkout", "Pay now", "Kauf abschließen", "Bestellung abschließen"])("still reads %j as a purchase", (text) => {
        expect(isPurchaseText(text)).toBe(true);
    });
});
