// @vitest-environment jsdom

/**
 * The prompts sidebar's add, clear, pagination, copy and more-actions controls
 * are icons only, and its search box has only a placeholder. Each needs a name.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    const prompts = Array.from({ length: 13 }, (_, index) => {
        return {
            _id: `p${index}`,
            content: "body",
            isFavorite: index === 0,
            name: `Prompt ${String(index).padStart(2, "0")}`,
        };
    });
    const noop = async () => {};
    const actions = new Map<string, () => Promise<unknown>>([
        [
            "getPromptCount",
            async () => {
                return { canCreate: true, count: 13, isPremium: true, limit: null };
            },
        ],
        ["getPrompts", async () => prompts],
    ]);

    return { actions, noop };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return { msg: (strings: TemplateStringsArray) => strings[0], plural: String };
});

vi.mock("@neore/backend/api", () => {
    return { api: { prompts: { functions: { getPrompts: "getPrompts", getPromptCount: "getPromptCount" } } } };
});

vi.mock("@tanstack/react-query", () => {
    const empty = { mutate: () => {}, mutateAsync: async () => {} };

    return {
        useMutation: (options: { kind?: string }) => (options.kind ? { mutateAsync: harness.actions.get(options.kind) } : empty),
        useQuery: () => {
            return { data: undefined };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const options = new Map<string, { kind: string }>();
    const entry = {
        mutationOptions: () => {
            return {};
        },
        queryOptions: () => {
            return {};
        },
    };

    return {
        useCRPC: () => {
            return {
                prompts: {
                    functions: {
                        createPrompt: entry,
                        deletePrompt: entry,
                        getResolvedVariables: entry,
                        recordPromptUsage: entry,
                        togglePromptFavorite: entry,
                        updatePrompt: entry,
                    },
                },
            };
        },
        useLunoraActionOptions: (kind: string) => {
            if (!options.has(kind)) {
                options.set(kind, { kind });
            }

            return options.get(kind);
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    const hooks = {
        useActiveOrganization: () => {
            return { data: undefined };
        },
        useSession: () => {
            return { data: { user: { id: "u1" } } };
        },
    };

    return {
        useAuth: () => {
            return { hooks };
        },
    };
});

vi.mock("@/features/billing/hooks/use-checkout", () => {
    return {
        default: () => {
            return { upgradeToast: () => {} };
        },
    };
});

vi.mock("@/features/chat/core/stores/chat-ui-store", () => {
    return { useChatUIStore: () => () => {} };
});

vi.mock("@/features/chat/core/stores/model-store", () => {
    return { useModelStore: () => () => {} };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

// Base UI's scroll viewport needs a real ResizeObserver, which jsdom lacks.
vi.mock("@neore/ui/components/scroll-area", () => {
    return { ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

vi.mock("@/components/delete-confirmation-dialog", () => {
    return { default: () => null };
});

vi.mock("./prompt-form-dialog", () => {
    return { default: () => null };
});

vi.mock("./variable-fill-dialog", () => {
    return { default: () => null };
});

const { default: PromptsSidebarTab } = await import("./prompts-sidebar-tab");

describe("PromptsSidebarTab", () => {
    it("names the add button, the search box and the pagination buttons", async () => {
        render(<PromptsSidebarTab />);

        expect(await screen.findByRole("button", { name: "Add prompt" })).toBeTruthy();
        expect(screen.getByRole("textbox", { name: "Search prompts" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Previous page" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Copy to clipboard" }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole("button", { name: "More actions" }).length).toBeGreaterThan(0);
    });

    it("names the clear button once there is a query", async () => {
        render(<PromptsSidebarTab />);

        fireEvent.change(await screen.findByRole("textbox", { name: "Search prompts" }), { target: { value: "Prompt" } });

        expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    });
});
