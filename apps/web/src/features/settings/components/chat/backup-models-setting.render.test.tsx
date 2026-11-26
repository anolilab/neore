/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what these tests assert */
import type { GatewayModel } from "@neore/ai/models";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackupModelsSetting } from "./default-models-settings";

const state = vi.hoisted(() => {
    return {
        catalog: [] as GatewayModel[],
        catalogLoaded: true,
        excluded: new Set<string>(),
        pending: false,
        preferencesRead: true,
        refuse: false,
        rerender: (() => undefined) as () => void,
        settings: {} as undefined | { backupModels?: string[] },
    };
});

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

vi.mock("@tanstack/react-query", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@tanstack/react-query")>()),
        useQuery: (options: { query?: string }) => {
            return { data: options.query === "preferences" && !state.preferencesRead ? undefined : { canRunPaidModels: true } };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getAIUserPreferences: {
                            queryOptions: () => {
                                return { query: "preferences" };
                            },
                        },
                        getPaidModelAccess: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

// The whole catalog, before feature flags hide any of it.
vi.mock("@/hooks/use-gateway-models", () => {
    return { useGatewayModels: () => state.catalog, useGatewayModelsLoaded: () => state.catalogLoaded };
});

vi.mock("@/hooks/use-model-filter-rules", () => {
    return { useFilteredModels: (models: GatewayModel[]) => models.filter((model) => !state.excluded.has(model.id)) };
});

// A save applies at once, as the optimistic cache update does; a refused one is rolled back before it rejects.
vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return {
                isPending: state.pending,
                updateLatest: async (build: (current: typeof state.settings) => typeof state.settings) => {
                    const before = state.settings;

                    state.settings = { ...state.settings, ...build(state.settings) };
                    state.rerender();

                    if (state.refuse) {
                        state.settings = before;
                        state.rerender();

                        throw new Error("refused");
                    }
                },
            };
        },
        useUserSettings: () => {
            return { data: state.settings };
        },
    };
});

const model = (id: string, name: string): GatewayModel => ({ enabled: true, id, mode: "text", name, provider: "openai" }) as GatewayModel;

const MODELS = [model("openai/first", "First"), model("openai/second", "Second"), model("openai/third", "Third")];

/** Shows the setting with `offered` as the picker's list: the catalog less what a feature flag hides. */
const show = (offered: GatewayModel[] = MODELS) => {
    const view = render(<BackupModelsSetting models={offered} providersWithKey={new Set()} />);

    state.rerender = () => view.rerender(<BackupModelsSetting models={offered} providersWithKey={new Set()} />);
};

beforeEach(() => {
    state.catalog = MODELS;
    state.catalogLoaded = true;
    state.pending = false;
    state.preferencesRead = true;
    state.refuse = false;
    state.excluded = new Set();
    state.settings = {};
    // The select positions its popup with a ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

describe("BackupModelsSetting", () => {
    it("marks a saved backup the user's model filters exclude as unavailable", () => {
        state.settings = { backupModels: ["openai/first", "openai/second"] };
        state.excluded = new Set(["openai/second"]);
        show();

        const [first, second] = screen.getAllByRole("listitem");

        expect(first?.textContent).not.toContain("Unavailable");
        expect(second?.textContent).toContain("Unavailable");
    });

    it("cannot be edited until the settings load, so an early add cannot replace the saved list", () => {
        state.settings = undefined;
        show();

        const picker = screen.getByRole("combobox", { name: "Add a backup model" });

        expect(picker.hasAttribute("disabled") || picker.dataset.disabled !== undefined).toBe(true);
    });

    it("does not mark a saved backup a feature flag hides from the picker as unavailable", () => {
        state.settings = { backupModels: ["openai/second"] };
        show([MODELS[0]!, MODELS[2]!]);

        const [entry] = screen.getAllByRole("listitem");

        expect(entry?.textContent).toContain("Second");
        expect(entry?.textContent).not.toContain("Unavailable");
    });

    it("moves focus to the new entry when adding it fills the list and the add picker goes", async () => {
        state.settings = { backupModels: ["openai/first", "openai/second"] };
        show();

        await userEvent.click(screen.getByRole("combobox", { name: "Add another backup model" }));
        await userEvent.click(await screen.findByRole("option", { name: "Third" }));

        expect(state.settings.backupModels).toEqual(["openai/first", "openai/second", "openai/third"]);
        expect(screen.queryByRole("combobox")).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Third" }));
    });

    it("marks nothing unavailable before the catalog has been read", () => {
        state.settings = { backupModels: ["openai/first"] };
        state.catalog = [];
        state.catalogLoaded = false;
        show();

        const [entry] = screen.getAllByRole("listitem");

        expect(entry?.textContent).not.toContain("Unavailable");
        expect(screen.getByRole("button", { name: "Remove openai/first" })).toBeDefined();
    });

    it("moves focus back to the add picker when an add that filled the list is refused", async () => {
        state.settings = { backupModels: ["openai/first", "openai/second"] };
        state.refuse = true;
        show();

        await userEvent.click(screen.getByRole("combobox", { name: "Add another backup model" }));
        await userEvent.click(await screen.findByRole("option", { name: "Third" }));

        expect(state.settings.backupModels).toEqual(["openai/first", "openai/second"]);
        expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Add another backup model" }));
    });

    it("marks nothing unavailable while the user's filters cannot be read", () => {
        state.settings = { backupModels: ["openai/first"] };
        state.excluded = new Set(["openai/first"]);
        state.preferencesRead = false;
        show();

        const [entry] = screen.getAllByRole("listitem");

        expect(entry?.textContent).not.toContain("Unavailable");
    });

    it("cannot be edited while a save runs, so a later edit is never built on a value that may be refused", () => {
        state.settings = { backupModels: ["openai/first", "openai/second"] };
        state.pending = true;
        show();

        expect(screen.getByRole("button", { name: "Remove First" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Move Second up" }).hasAttribute("disabled")).toBe(true);
    });

    it("keeps focus on the moved backup, on its other arrow when the one used is now disabled", async () => {
        state.settings = { backupModels: ["openai/first", "openai/second", "openai/third"] };
        show();

        await userEvent.click(screen.getByRole("button", { name: "Move Third up" }));

        expect(state.settings.backupModels).toEqual(["openai/first", "openai/third", "openai/second"]);
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Third up" }));

        await userEvent.click(screen.getByRole("button", { name: "Move Third up" }));

        expect(state.settings.backupModels).toEqual(["openai/third", "openai/first", "openai/second"]);
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Third down" }));
    });

    it("moves focus to the next backup's remove button when one is removed", async () => {
        state.settings = { backupModels: ["openai/first", "openai/second", "openai/third"] };
        show();

        await userEvent.click(screen.getByRole("button", { name: "Remove First" }));

        expect(state.settings.backupModels).toEqual(["openai/second", "openai/third"]);
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Second" }));
    });

    it("moves focus to the previous backup's remove button when the last is removed", async () => {
        state.settings = { backupModels: ["openai/first", "openai/second"] };
        show();

        await userEvent.click(screen.getByRole("button", { name: "Remove Second" }));

        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove First" }));
    });

    it("moves focus to the add picker when the only backup is removed", async () => {
        state.settings = { backupModels: ["openai/first"] };
        show();

        await userEvent.click(screen.getByRole("button", { name: "Remove First" }));

        expect(screen.queryAllByRole("listitem")).toHaveLength(0);
        expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Add a backup model" }));
    });
});
