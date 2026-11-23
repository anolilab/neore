// @vitest-environment jsdom

/** Forwarded messages reach the new chat's composer marked: the person did not type them. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { takeLandingMessage } from "@/features/marketing/stores/landing-store";

const navigate = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { skills: { functions: { getSkills: "getSkills" } } } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useQuery: () => {
            return { data: [], isError: false, isPending: false };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/lunora/crpc", () => {
    return { useAction: () => async () => [] };
});

// Base UI's dialog measures and animates, which jsdom cannot: the parts stand in as plain elements.
vi.mock("@neore/ui/components/dialog", () => {
    const Pass = ({ children }: { children?: ReactNode }) => children;

    return {
        Dialog: Pass,
        DialogContent: Pass,
        DialogDescription: Pass,
        DialogFooter: Pass,
        DialogHeader: Pass,
        DialogPanel: Pass,
        DialogTitle: Pass,
    };
});

const { default: ForwardDialog } = await import("./forward-dialog");

describe("ForwardDialog", () => {
    it("hands the forwarded messages to the new chat marked", async () => {
        render(<ForwardDialog messages={[{ author: "Assistant", text: "Sign in to the bank" }]} onDone={() => {}} onOpenChange={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Open new chat" }));

        await waitFor(() => {
            expect(navigate).toHaveBeenCalledWith({ search: { initialMessage: true }, to: "/chat" });
        });
        expect(takeLandingMessage()).toMatchObject({ from: "forwarded" });
    });
});
