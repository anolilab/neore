import type { GatewayModel } from "@neore/ai/models";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ModelPicker from "./model-picker";

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
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
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

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: null };
                    },
                },
            };
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

// Base UI's scroll area constructs a ResizeObserver; the shared setup's stub (redefined before each test) is not a
// constructor, so this one is set after it.
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

const kimi = { displayProvider: "Moonshot", id: "cf-kimi-k2.5", mode: "text", name: "Kimi K2.5 (Workers AI)", provider: "cloudflare" } as GatewayModel;
const gpt = { displayProvider: "OpenAI", id: "openai/gpt-5", mode: "text", name: "GPT-5", provider: "openrouter" } as GatewayModel;

const picker = (models: GatewayModel[]) => <ModelPicker defaultModeFilter="text" defaultTab="all" footer={null} initialModelId={kimi.id} models={models} />;

describe("ModelPicker opening scope", () => {
    it("scopes to the selected model's creator when the catalog arrives after the picker opened", () => {
        const view = render(picker([]));

        view.rerender(picker([kimi, gpt]));

        expect(screen.getByText("Kimi K2.5 (Workers AI)")).toBeTruthy();
        expect(screen.queryByText("GPT-5")).toBeNull();
    });

    it("scopes to the creator straight away when the catalog is already there", () => {
        render(picker([kimi, gpt]));

        expect(screen.getByText("Kimi K2.5 (Workers AI)")).toBeTruthy();
        expect(screen.queryByText("GPT-5")).toBeNull();
    });

    it("waits for the selected model, not just any model, before scoping", () => {
        const view = render(picker([gpt]));

        expect(screen.getByText("GPT-5")).toBeTruthy();

        view.rerender(picker([gpt, kimi]));

        expect(screen.getByText("Kimi K2.5 (Workers AI)")).toBeTruthy();
        expect(screen.queryByText("GPT-5")).toBeNull();
    });

    it("drops the scope when the selected model's creator leaves the list", () => {
        const view = render(picker([kimi, gpt]));

        view.rerender(picker([gpt]));

        expect(screen.getByText("GPT-5")).toBeTruthy();
    });

    it("keeps the opening scope when leaving Starred for All models", () => {
        render(<ModelPicker defaultModeFilter="text" footer={null} initialModelId={kimi.id} models={[kimi, gpt]} />);

        fireEvent.click(screen.getByRole("button", { name: "All models" }));

        expect(screen.getByText("Kimi K2.5 (Workers AI)")).toBeTruthy();
        expect(screen.queryByText("GPT-5")).toBeNull();
    });
});
