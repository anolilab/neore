/**
 * `<OrganizationSwitcher>`: switching the active organization drops the cached billing
 * read, so the next read reports the newly active organization's plan, and leaves the
 * other cached reads alone.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        default: ({
            isPending,
            onSwitch,
            organizations,
        }: {
            isPending: boolean;
            onSwitch: (id: string) => void;
            organizations: { id: string; name: string }[];
        }) =>
            createElement(
                "div",
                null,
                createElement("output", null, isPending ? "switching" : "idle"),
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

type HeldCall<T> = { promise: Promise<T>; reject: (error: Error) => void; resolve: (value: T) => void };

/** A call that stays open until the test settles it. */
const holdCall = <T,>(): HeldCall<T> => {
    const held = {} as HeldCall<T>;

    // The tsconfig lib and the configured Node range predate `Promise.withResolvers`.

    held.promise = new Promise<T>((resolve: (value: T) => void, reject: (error: Error) => void) => {
        held.reject = reject;
        held.resolve = resolve;
    });

    return held;
};

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
            expect(queryClient.getQueryData(["billing-info"])).toBeUndefined();
        });
        expect(harness.setActive).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_b" }));
        expect(queryClient.getQueryState(["other-read"])?.isInvalidated).toBe(false);
    });

    it("shows the localized error and stops switching when the switch is rejected", async () => {
        const pendingSwitch = holdCall<unknown>();

        harness.setActive.mockImplementationOnce(() => pendingSwitch.promise);

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        render(createElement(QueryClientProvider, { client: queryClient }, createElement(OrganizationSwitcher)));

        fireEvent.click(screen.getByRole("button", { name: "Beta" }));

        expect(screen.getByText("switching")).toBeTruthy();

        await act(async () => {
            // What the auth client throws for a failed request: the server's body, with its error code, under `error`.
            pendingSwitch.reject(
                Object.assign(new Error("Bad Request"), { error: { code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" }, status: 400 }),
            );
        });

        expect(screen.getByText("idle")).toBeTruthy();
        expect(harness.toast).toHaveBeenCalledExactlyOnceWith({ message: "Organization not found", variant: "error" });
    });
});
