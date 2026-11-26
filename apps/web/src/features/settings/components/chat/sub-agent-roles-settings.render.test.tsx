import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SubAgentRolesSettings from "./sub-agent-roles-settings";

const state = vi.hoisted(() => {
    return {
        project: null as null | { editable: boolean; roles: Record<string, unknown> },
        projects: [] as { _id: string; title: string }[],
        accessPending: false,
        customProviders: [] as Record<string, unknown>[],
        roles: {} as Record<string, unknown>,
        rolesFail: false,
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
const HOSTED_MODEL = /hosted model/u;
const LAPTOP_MODEL = /laptop model/u;

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

// `default-models-settings` imports the catalog hooks, which read the app's environment at import time.
vi.mock("@/hooks/use-gateway-models", () => {
    return {
        useGatewayModels: () => MODELS,
        useGatewayModelsLoaded: () => true,
        useGatewayModelsSettled: () => true,
        useRefetchGatewayModels: () => vi.fn(),
    };
});

vi.mock("@/features/tasks/hooks/use-task-projects", () => {
    return {
        default: () => {
            return { hasMore: false, isLoadingMore: false, loadMore: vi.fn(), readableProjects: state.projects };
        },
    };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: false };
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
                                        if (state.accessPending) {
                                            await new Promise(() => {});
                                        }

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
                chat: {
                    custom_providers: {
                        listCustomProviders: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => state.customProviders,
                                    queryKey: ["custom-providers"],
                                };
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
                                        if (state.rolesFail) {
                                            throw new Error("offline");
                                        }

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
    state.accessPending = false;
    state.customProviders = [];
    state.roles = {};
    state.rolesFail = false;
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

    it("offers the user's server-side endpoints, and not one only the browser can reach", async () => {
        const endpoint = (id: string, type: string) => {
            return {
                baseUrl: "https://example.test",
                enabled: true,
                hasApiKey: true,
                id,
                models: [{ id: `${id}-model`, name: `${id} model` }],
                name: id,
                supportsTools: true,
                type,
            };
        };

        state.customProviders = [endpoint("hosted", "openai"), endpoint("laptop", "local-browser")];
        renderSettings();

        const user = userEvent.setup();
        const [picker] = await screen.findAllByRole("combobox", { name: "Model" });

        await user.click(picker!);

        expect(await screen.findByRole("option", { name: HOSTED_MODEL })).toBeDefined();
        expect(screen.queryByRole("option", { name: LAPTOP_MODEL })).toBeNull();
    });

    it("shows no role to edit when the roles cannot be read, and reads them again on Retry", async () => {
        state.rolesFail = true;
        renderSettings();

        const retry = await screen.findByRole("button", { name: "Retry" });

        expect(screen.queryAllByLabelText("Extra instructions")).toHaveLength(0);

        state.rolesFail = false;
        fireEvent.click(retry);

        expect(await screen.findAllByLabelText("Extra instructions")).toHaveLength(8);
    });

    it("saves instructions still being typed when the settings close", async () => {
        const view = renderSettings();
        const [first] = await screen.findAllByLabelText("Extra instructions");

        first!.focus();
        fireEvent.change(first!, { target: { value: "Name the trade-offs." } });
        view.unmount();

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalledTimes(1);
        });
        expect(state.setSubAgentRole.mock.calls[0]?.[0]).toStrictEqual({ config: { instructions: "Name the trade-offs." }, role: "architecture" });
    });

    it("shows a saved model the picker no longer offers, and says it cannot run", async () => {
        state.roles = { review: { model: "model-gone" } };
        renderSettings();

        expect(await screen.findByText("This model cannot run for you, so the role is not offered to the assistant. Pick another one.")).toBeDefined();
        expect(screen.getAllByText("model-gone").length).toBeGreaterThan(0);
    });

    it("does not call a saved model unusable before the plan it depends on has loaded", async () => {
        state.accessPending = true;
        state.roles = { review: { model: "model-gone" } };
        renderSettings();

        await screen.findAllByText("model-gone");
        expect(screen.queryByText("This model cannot run for you, so the role is not offered to the assistant. Pick another one.")).toBeNull();
    });

    it("sends one card's save only after another card's earlier save has finished", async () => {
        let finishFirst: (value: null) => void = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- not in this project's TypeScript lib (es2023)
        const first = new Promise<null>((resolve) => {
            finishFirst = resolve;
        });

        state.setSubAgentRole.mockImplementationOnce(async () => await first);
        renderSettings();

        const [architecture, implementation] = await screen.findAllByLabelText("Extra instructions");

        fireEvent.change(architecture!, { target: { value: "First." } });
        fireEvent.blur(architecture!);
        fireEvent.change(implementation!, { target: { value: "Second." } });
        fireEvent.blur(implementation!);

        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalledTimes(1);
        });
        // The second waits behind the first; on a line of its own it would have gone by now.
        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });
        expect(state.setSubAgentRole).toHaveBeenCalledTimes(1);
        finishFirst(null);
        await waitFor(() => {
            expect(state.setSubAgentRole).toHaveBeenCalledTimes(2);
        });
        expect(state.setSubAgentRole.mock.calls[1]?.[0]).toMatchObject({ role: "implementation" });
    });

    it("keeps the switch-off over a typed draft when the card goes away", async () => {
        state.roles = { review: { instructions: "Check auth.", model: "model-a" } };
        state.project = { editable: true, roles: {} };
        state.projects = [{ _id: "p1", title: "Project one" }];
        const view = renderSettings();
        const user = userEvent.setup();

        await screen.findAllByText("Off until you pick a model.");
        await user.click(screen.getByRole("combobox", { name: "Applies to" }));
        await user.click(await screen.findByRole("option", { name: "Project one" }));

        // Activated with focus still in the field (a screen reader's virtual cursor), so no blur saves the draft first.
        const fields = await screen.findAllByLabelText("Extra instructions");

        fireEvent.change(fields[3]!, { target: { value: "Typed." } });
        fireEvent.click(screen.getByRole("button", { name: "Don't use your default instructions in this project" }));
        view.unmount();

        await waitFor(() => {
            expect(state.setProjectSubAgentRole).toHaveBeenCalled();
        });
        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });
        expect(state.setProjectSubAgentRole.mock.calls.map((call) => call[0])).toStrictEqual([
            { config: { instructions: "" }, projectId: "p1", role: "review" },
        ]);
    });
});
