import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SubAgentRolesSettings from "./sub-agent-roles-settings";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

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

const MODELS = [{ enabled: true, id: "model-a", mode: "text", name: "Model A", provider: "test" }];

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => MODELS };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const state = vi.hoisted(() => {
    return { roles: {} as Record<string, unknown>, setSubAgentRole: vi.fn(async (_variables: unknown) => null) };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getAIUserPreferences: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { providerApiKeys: {} };
                                    },
                                    queryKey: ["ai-preferences"],
                                };
                            },
                        },
                        getPaidModelAccess: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { canRunPaidModels: true };
                                    },
                                    queryKey: ["paid-access"],
                                };
                            },
                        },
                        setSubAgentRole: {
                            mutationOptions: () => {
                                return { mutationFn: state.setSubAgentRole };
                            },
                        },
                    },
                },
                projects: {
                    functions: {
                        listProjects: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { continueCursor: null, isDone: true, page: [] };
                                    },
                                    queryKey: ["projects"],
                                };
                            },
                        },
                        setProjectSubAgentRole: {
                            mutationOptions: () => {
                                return { mutationFn: vi.fn() };
                            },
                        },
                    },
                },
                sub_agents: {
                    role_settings: {
                        getSubAgentRoles: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { project: null, user: state.roles };
                                    },
                                    queryKey: ["roles"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const renderSettings = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <SubAgentRolesSettings />
        </QueryClientProvider>,
    );

beforeEach(() => {
    state.roles = {};
    state.setSubAgentRole.mockClear();
});

describe("SubAgentRolesSettings", () => {
    it("lists every role, each off until it has a model", async () => {
        renderSettings();

        expect(await screen.findByText("Architecture")).toBeDefined();
        expect(screen.getByText("Security")).toBeDefined();
        expect(screen.getAllByText("Off until you pick a model.")).toHaveLength(8);
        expect(screen.queryByRole("group", { name: "When to delegate" })).toBeNull();
    });

    it("saves the mode of a role that has a model, keeping its model", async () => {
        state.roles = { review: { model: "model-a" } };
        renderSettings();

        fireEvent.click(await screen.findByRole("button", { name: "Always" }));

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalled();
        });
        expect(state.setSubAgentRole.mock.calls[0]?.[0]).toStrictEqual({ config: { mode: "always", model: "model-a" }, role: "review" });
    });

    it("saves the instructions when the field loses focus, and nothing when they did not change", async () => {
        renderSettings();

        const [first] = await screen.findAllByLabelText("Extra instructions");

        fireEvent.blur(first!);
        expect(state.setSubAgentRole).not.toHaveBeenCalled();

        fireEvent.change(first!, { target: { value: "Name the trade-offs." } });
        fireEvent.blur(first!);

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalled();
        });
        expect(state.setSubAgentRole.mock.calls[0]?.[0]).toStrictEqual({ config: { instructions: "Name the trade-offs." }, role: "architecture" });
    });
});
