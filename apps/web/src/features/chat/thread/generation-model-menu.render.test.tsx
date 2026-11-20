// @vitest-environment jsdom

/** Generate image/video sends the reply's text as the prompt, marked: the person did not type it. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const sendMessage = vi.hoisted(() =>
    vi.fn(async () => {
        return { ok: true };
    }),
);

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Trans: ({ children }: { children: React.ReactNode }) => children,
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { sendMessage };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    const models = [{ enabled: true, id: "image-model", mode: "image" }];

    return { default: () => models };
});

vi.mock("@/components/model-picker", () => {
    return { ModelPicker: () => null };
});

vi.mock("@/features/chat/components/cinema-studio", () => {
    return { CinemaPanel: () => null };
});

vi.mock("./composer-image-settings", () => {
    return { default: () => null };
});

vi.mock("./composer-video-settings", () => {
    return { default: () => null };
});

vi.mock("./composer-audio-settings", () => {
    return { default: () => null };
});

const { default: GenerationModelMenu } = await import("./generation-model-menu");

describe("GenerationModelMenu", () => {
    it("sends the reply's text marked as not typed", async () => {
        render(<GenerationModelMenu icon={null} messageText="A lighthouse at dusk" mode="image" threadId="thread-1" tooltip="Generate image" />);

        fireEvent.click(screen.getByRole("button", { name: "Generate image" }));
        fireEvent.click(await screen.findByRole("button", { name: "Generate" }));

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith("A lighthouse at dusk", undefined, { draftFrom: "assistantText" });
        });
    });
});
