// @vitest-environment jsdom

/** The improver's Apply puts the model's rewrite into the composer marked: sent, it is not the person's own words. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id }, t };
        },
    };
});

vi.mock("@/features/chat/prompt-improvement/hooks/use-optimizer-style-labels", () => {
    const labels = new Proxy(
        {},
        {
            get: () => {
                return { description: "", label: "" };
            },
        },
    );

    return {
        default: () => {
            return { system: labels, user: labels };
        },
    };
});

vi.mock("@/features/chat/prompt-improvement/hooks/use-prompt-improvement", () => {
    return {
        default: () => {
            return { improvePrompt: vi.fn(), iterate: vi.fn() };
        },
    };
});

const { default: PromptImprovementPanel } = await import("./prompt-improvement-panel");

beforeEach(() => {
    useChatUIStore.getState().reset();
    usePromptImprovementStore.getState().open("draft a reply", undefined);
    usePromptImprovementStore.getState().addImprovedPrompt("Draft a short, polite reply that declines the meeting.");
});

describe("PromptImprovementPanel", () => {
    it("marks the composer's draft when the rewrite is applied", () => {
        render(<PromptImprovementPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Apply" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft a short, polite reply that declines the meeting.");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("improvedPrompt");
    });
});
