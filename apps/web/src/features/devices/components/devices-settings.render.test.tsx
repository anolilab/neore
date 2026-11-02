/**
 * A computer too old for the backend cannot start a coding agent: the Start button is off and points at the reason.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartAgents } from "./devices-settings";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn() } };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => vi.fn() };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                acp: {
                    remote: {
                        startHostSession: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn(async () => null) };
                            },
                        },
                    },
                },
            };
        },
    };
});

const device = {
    _id: "d1",
    acpOffers: [{ agentKey: "claude", agentLabel: "Claude", folderId: "f1", folderLabel: "app" }],
    name: "Laptop",
    platform: "macos",
    toolNames: [],
};

const renderStart = (updateRequired: boolean) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <StartAgents device={{ ...device, updateRequired } as never} online />
        </QueryClientProvider>,
    );

describe("<StartAgents>", () => {
    it("disables Start for a computer that needs an update and names the reason", () => {
        renderStart(true);

        const button = screen.getByRole("button", { name: "Start Claude in app" }) as HTMLButtonElement;

        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-describedby")).toBe("device-update-d1");
    });

    it("leaves Start on for an up-to-date computer", () => {
        renderStart(false);

        const button = screen.getByRole("button", { name: "Start Claude in app" }) as HTMLButtonElement;

        expect(button.disabled).toBe(false);
        expect(button.getAttribute("aria-describedby")).toBeNull();
    });
});
