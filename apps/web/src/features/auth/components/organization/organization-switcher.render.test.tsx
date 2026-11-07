/**
 * `<OrganizationSwitcher>`: switching the active organization drops the cached billing
 * read, so the next read reports the newly active organization's plan, and leaves the
 * other cached reads alone.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
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

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => vi.fn(),
    };
});

// The chat-ui switcher is replaced by a plain list, one button per organization, so the test drives `onSwitch` directly.
vi.mock("@neore/chat-ui/org-switcher/org-switcher", () => {
    return {
        default: ({ onSwitch, organizations }: { onSwitch: (id: string) => void; organizations: { id: string; name: string }[] }) =>
            createElement(
                "div",
                null,
                organizations.map((organization) =>
                    createElement("button", { key: organization.id, onClick: () => onSwitch(organization.id), type: "button" }, organization.name),
                ),
            ),
    };
});

vi.mock("./create-organization-dialog", () => {
    return {
        default: () => null,
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: { organization: { setActive: harness.setActive } },
                basePath: "/settings",
                hooks: {
                    useActiveOrganization: () => {
                        return { data: { id: "org_a", name: "Acme" }, refetch: async () => undefined };
                    },
                    useListOrganizations: () => {
                        return {
                            data: [
                                { id: "org_a", name: "Acme", slug: "acme" },
                                { id: "org_b", name: "Beta", slug: "beta" },
                            ],
                        };
                    },
                    useSession: () => {
                        return { data: { user: { email: "member@example.test", name: "Member" } } };
                    },
                },
                settings: undefined,
                toast: harness.toast,
            };
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
                },
            };
        },
    };
});

const { default: OrganizationSwitcher } = await import("./organization-switcher");

afterEach(() => {
    vi.clearAllMocks();
});

describe("OrganizationSwitcher", () => {
    it("drops the cached billing read when the visitor switches organizations, and no other cached read", async () => {
        const user = userEvent.setup();

        harness.setActive.mockResolvedValue({});

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        queryClient.setQueryData(["billing-info"], { baseTier: "enterprise", creditsPerUser: 10_000 });
        queryClient.setQueryData(["other-read"], { ok: true });

        render(createElement(QueryClientProvider, { client: queryClient }, createElement(OrganizationSwitcher)));

        await user.click(screen.getByRole("button", { name: "Beta" }));

        await waitFor(() => {
            expect(queryClient.getQueryState(["billing-info"])?.isInvalidated).toBe(true);
        });
        expect(harness.setActive).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_b" }));
        expect(queryClient.getQueryState(["other-read"])?.isInvalidated).toBe(false);
    });
});
