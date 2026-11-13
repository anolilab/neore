/**
 * Typing in the model picker's search re-filters the list on every keystroke. A row that is still listed, in the same
 * state, is not rendered again: only rows whose match changed are.
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

const { ModelPicker } = await import("@neore/chat-ui/model-picker/model-picker");

const model = (id: string, name: string, displayProvider: string) => ({ displayProvider, id, mode: "text", name, provider: "gateway" }) as GatewayModel;

const MODELS = [
    model("openai/gpt-5", "GPT-5", "OpenAI"),
    model("openai/gpt-4o", "GPT-4o", "OpenAI"),
    model("anthropic/claude-sonnet", "Claude Sonnet", "Anthropic"),
    model("mistral/large", "Large", "Mistral"),
];

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

describe("ModelPicker search", () => {
    it("re-renders only the rows whose match changed", () => {
        render(<ModelPicker defaultModeFilter="text" defaultTab="all" footer={null} models={MODELS} />);

        // Both GPT rows were listed before and still are; the other creators' rows leave.
        search("gpt");

        expect(screen.getAllByRole("option")).toHaveLength(2);
        expect(rowRenders.get("openai/gpt-5") ?? 0).toBe(0);
        expect(rowRenders.get("openai/gpt-4o") ?? 0).toBe(0);

        // GPT-5 leaves; GPT-4o stays as it was, though its group changed.
        search("gpt-4");

        expect(screen.getAllByRole("option")).toHaveLength(1);
        expect(rowRenders.get("openai/gpt-4o") ?? 0).toBe(0);
    });
});
