// @vitest-environment jsdom

/**
 * `<TeamSwitcher>`: a team switch shows the skeleton while it runs and clears it after, posting the error toast when the
 * switch is rejected, and the success toast in the language that is active when it posts.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        invalidateQueries: vi.fn(async () => undefined),
        locale: "en",
        setActiveTeam: vi.fn(),
        toast: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                // Reads the language when called, as Lingui's `t` does after an in-place locale change.
                t: (strings: TemplateStringsArray, ...values: unknown[]) => `${harness.locale}:${String.raw({ raw: strings }, ...values)}`,
            };
        },
    };
});

vi.mock("@neore/ui/components/responsive-dropdown-menu", () => {
    const passthrough = ({ children }: { children?: ReactNode }) => createElement("div", null, children);

    return {
        DropdownMenu: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) =>
            createElement("button", { onClick, type: "button" }, children),
        DropdownMenuSeparator: () => null,
        DropdownMenuTrigger: passthrough,
    };
});

vi.mock("@neore/ui/components/skeleton", () => {
    return { Skeleton: () => createElement("span", { "data-testid": "switching" }) };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: harness.setActiveTeam };
        },
        useQuery: () => {
            return {
                data: [{ createdAt: 0, id: "team_a", name: "Design", role: "member" }],
                isPending: false,
            };
        },
        useQueryClient: () => {
            return { invalidateQueries: harness.invalidateQueries };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    team: {
                        getMyTeams: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                        setActiveTeam: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useActiveOrganization: () => {
                        return { data: { id: "org_a", name: "Acme" }, isPending: false };
                    },
                },
                toast: harness.toast,
            };
        },
    };
});

vi.mock("../../lib/utilities", () => {
    return {
        getLocalizedError: ({ error }: { error: Error }) => `localized:${error.message}`,
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

const { default: TeamSwitcher } = await import("./team-switcher");

/** Clicks the team and holds its switch open, returning how to settle it. */
const startSwitch = (): HeldCall<void> => {
    const pendingSwitch = holdCall<void>();

    harness.setActiveTeam.mockImplementationOnce(() => pendingSwitch.promise);

    fireEvent.click(screen.getByRole("button", { name: "Design" }));

    return pendingSwitch;
};

afterEach(() => {
    vi.clearAllMocks();
    harness.locale = "en";
});

describe("TeamSwitcher", () => {
    it("shows the localized error and stops switching when the switch is rejected", async () => {
        render(createElement(TeamSwitcher));

        const save = startSwitch();

        expect(screen.getByTestId("switching")).toBeTruthy();

        await act(async () => {
            save.reject(new Error("forbidden"));
        });

        expect(screen.queryByTestId("switching")).toBeNull();
        expect(harness.toast).toHaveBeenCalledExactlyOnceWith({ message: "localized:forbidden", variant: "error" });
    });

    it("posts the success toast in the language active when the switch finishes", async () => {
        render(createElement(TeamSwitcher));

        const save = startSwitch();

        harness.locale = "de";

        await act(async () => {
            save.resolve();
        });

        expect(screen.queryByTestId("switching")).toBeNull();
        expect(harness.toast).toHaveBeenCalledExactlyOnceWith({ message: "de:Switched to team view", variant: "success" });
    });
});
