import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SubAgentRolesSettings from "./sub-agent-roles-settings";

const state = vi.hoisted(() => {
    return {
        project: null as null | { editable: boolean; roles: Record<string, unknown> },
        projects: [] as { _id: string; title: string }[],
        roles: {} as Record<string, unknown>,
        setProjectSubAgentRole: vi.fn(async (_variables: unknown) => null),
        setSubAgentRole: vi.fn(async (_variables: unknown) => null),
    };
});

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

const MODELS = [
    { enabled: true, filterCapabilities: ["reasoning"], id: "model-a", mode: "text", name: "Model A", provider: "test" },
    { enabled: true, filterCapabilities: [], id: "model-labs", mode: "text", name: "Model Labs", provider: "test" },
];

const MODEL_A = /Model A/u;
const MODEL_LABS = /Model Labs/u;

// `model-labs` sits behind a feature flag, which a sub-agent role may not run on.
vi.mock("@neore/ai/models", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@neore/ai/models")>();

    return {
        ...actual,
        MODEL_LOOKUP: new Map([
            ["model-a", { enabled: true, id: "model-a", listed: true, provider: "test" }],
            ["model-labs", { enabled: true, featureFlag: "labs", id: "model-labs", listed: true, provider: "test" }],
        ]),
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => MODELS };
});

vi.mock("@/features/tasks/hooks/use-task-projects", () => {
    return {
        default: () => {
            return { hasMore: false, isLoadingMore: false, loadMore: vi.fn(), readableProjects: state.projects };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
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
                        setProjectSubAgentRole: {
                            mutationOptions: () => {
                                return { mutationFn: state.setProjectSubAgentRole };
                            },
                        },
                    },
                },
                sub_agents: {
                    role_settings: {
                        getSubAgentRoles: {
                            queryOptions: (args: { projectId?: string }) => {
                                return {
                                    queryFn: async () => {
                                        return { project: args.projectId ? state.project : null, user: state.roles };
                                    },
                                    queryKey: ["roles", args.projectId ?? null],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

const renderSettings = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
    render(
        <QueryClientProvider client={client}>
            <SubAgentRolesSettings />
        </QueryClientProvider>,
    );

beforeEach(() => {
    // The scope picker positions its popup with a ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
    state.project = null;
    state.projects = [];
    state.roles = {};
    state.setProjectSubAgentRole.mockClear();
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

    it("keeps an earlier edit in the next save, before the server has answered the first", async () => {
        state.roles = { review: { model: "model-a" } };
        renderSettings();

        fireEvent.click(await screen.findByRole("button", { name: "Always" }));

        const fields = screen.getAllByLabelText("Extra instructions");
        const review = fields[3]!;

        fireEvent.change(review, { target: { value: "Rank by severity." } });
        fireEvent.blur(review);

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalledTimes(2);
        });
        expect(state.setSubAgentRole.mock.calls[1]?.[0]).toStrictEqual({
            config: { instructions: "Rank by severity.", mode: "always", model: "model-a" },
            role: "review",
        });
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

    it("saves an effort the slider was just moved to when the card goes away", async () => {
        state.roles = { review: { model: "model-a" } };
        const view = renderSettings();

        fireEvent.change(await screen.findByLabelText("Reasoning Effort"), { target: { value: "75" } });
        expect(state.setSubAgentRole).not.toHaveBeenCalled();
        view.unmount();

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalledTimes(1);
        });
        expect(state.setSubAgentRole.mock.calls[0]?.[0]).toMatchObject({ config: { model: "model-a", reasoningEffort: expect.any(Number) }, role: "review" });
    });

    it("turns off the user's instructions in a project with an empty override", async () => {
        state.roles = { review: { instructions: "Check auth.", model: "model-a" } };
        state.project = { editable: true, roles: {} };
        state.projects = [{ _id: "p1", title: "Project one" }];
        renderSettings();

        const user = userEvent.setup();

        await screen.findAllByText("Off until you pick a model.");
        await user.click(screen.getByRole("combobox", { name: "Applies to" }));
        await user.click(await screen.findByRole("option", { name: "Project one" }));
        fireEvent.click(await screen.findByRole("button", { name: "Don't use your default instructions in this project" }));

        await waitFor(() => {
            expect(state.setProjectSubAgentRole).toHaveBeenCalled();
        });
        expect(state.setProjectSubAgentRole.mock.calls[0]?.[0]).toStrictEqual({ config: { instructions: "" }, projectId: "p1", role: "review" });
    });

    it("offers no model a role's save would refuse", async () => {
        renderSettings();

        const user = userEvent.setup();
        const [picker] = await screen.findAllByRole("combobox", { name: "Model" });

        await user.click(picker!);

        expect(await screen.findByRole("option", { name: MODEL_A })).toBeDefined();
        expect(screen.queryByRole("option", { name: MODEL_LABS })).toBeNull();
    });

    it("shows instructions saved elsewhere, and does not write the old ones back on blur", async () => {
        state.roles = { review: { instructions: "Old text.", model: "model-a" } };
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        renderSettings(client);

        await screen.findByDisplayValue("Old text.");
        act(() => {
            client.setQueryData(["roles", null], { project: null, user: { review: { instructions: "New text.", model: "model-a" } } });
        });

        const field = await screen.findByDisplayValue("New text.");

        fireEvent.blur(field);
        expect(state.setSubAgentRole).not.toHaveBeenCalled();
    });
});
