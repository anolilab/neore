/**
 * Typing in the model picker's search re-filters the list on every keystroke. A row that is still listed, in the same
 * state, is not rendered again: only rows whose match changed are. Covers the web app's picker and the shared one the
 * browser extension mounts.
 */
import type { GatewayModel } from "@neore/ai/models";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rowRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

// Counts each row's renders by the model it shows; the item itself is the real one.
vi.mock("@neore/ui/components/command", async (importOriginal) => {
    const original = await importOriginal<typeof import("@neore/ui/components/command")>();
    const CountedCommandItem = (props: ComponentProps<typeof original.CommandItem>) => {
        const id = (props as { "data-model-id"?: string })["data-model-id"] ?? "";

        rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1);

        return createElement(original.CommandItem, props);
    };

    return { ...original, CommandItem: CountedCommandItem };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@/hooks/use-model-filter-rules", () => {
    return {
        useBlockedCreators: () => {
            return { blockedCreators: [], isLoaded: true, setBlockedCreators: vi.fn() };
        },
        withCreatorHidden: (blocked: string[]) => blocked,
        withoutCreator: (blocked: string[]) => blocked,
    };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: null };
        },
    };
});

vi.mock("@/features/auth/hooks/use-invite-only", () => {
    return {
        default: () => {
            return { canSignUp: true, inviteOnly: false, mustSignIn: false, signUpHref: "/auth/sign-up" };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-model-nicknames", () => {
    return {
        default: () => {
            return { nicknames: {} };
        },
    };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

vi.mock("@tanstack/react-router", () => {
    return { Link: ({ children }: { children: ReactNode }) => children };
});

const { ModelPicker: SharedModelPicker } = await import("@neore/chat-ui/model-picker/model-picker");
const { default: WebModelPicker } = await import("./model-picker");

const model = (id: string, name: string, displayProvider: string) => ({ displayProvider, id, mode: "text", name, provider: "gateway" }) as GatewayModel;

const MODELS = [
    model("openai/gpt-5", "GPT-5", "OpenAI"),
    model("openai/gpt-4o", "GPT-4o", "OpenAI"),
    model("anthropic/claude-sonnet", "Claude Sonnet", "Anthropic"),
    model("mistral/large", "Large", "Mistral"),
];

// The model rows only: the web picker's sort control has options of its own.
const listedRows = () => screen.getAllByRole("option").filter((option: HTMLElement) => option.dataset.modelId !== undefined);

const search = (query: string) => {
    rowRenders.clear();
    fireEvent.change(screen.getByPlaceholderText("Search models..."), { target: { value: query } });
};

// Base UI's scroll area constructs a ResizeObserver.
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

describe.each([
    ["web", WebModelPicker],
    ["shared (browser extension)", SharedModelPicker],
])("%s ModelPicker search", (_name: string, ModelPicker: typeof WebModelPicker | typeof SharedModelPicker) => {
    it("re-renders only the rows whose match changed", () => {
        render(<ModelPicker defaultModeFilter="text" defaultTab="all" footer={null} models={MODELS} />);

        // Both GPT rows were listed before and still are; the other creators' rows leave.
        search("gpt");

        expect(listedRows()).toHaveLength(2);
        expect(rowRenders.get("openai/gpt-5") ?? 0).toBe(0);
        expect(rowRenders.get("openai/gpt-4o") ?? 0).toBe(0);

        // GPT-5 leaves; GPT-4o stays as it was, though its group changed.
        search("gpt-4");

        expect(listedRows()).toHaveLength(1);
        expect(rowRenders.get("openai/gpt-4o") ?? 0).toBe(0);
    });
});
