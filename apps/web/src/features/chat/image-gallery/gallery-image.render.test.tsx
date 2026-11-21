// @vitest-environment jsdom

/** A browser screenshot in a reply opens the chat's image gallery at it, once the app provides the gallery. */
import { ImageOpenContext } from "@neore/chat-ui/chat/image-open-context";
import MessageContentUI from "@neore/chat-ui/chat/message-content";
import type { ChatMessage } from "@neore/chat-ui/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ other, value }: { other: string; value: number }) => other.replace("#", () => String(value)),
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@neore/ui/components/zoomable-image", () => {
    return {
        ZoomableImage: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
    };
});

const OPEN_SCREENSHOT = { name: "Open Pricing in the image gallery" };

const reply = {
    id: "m1",
    parts: [
        {
            input: { url: "https://shop.example/pricing" },
            output: { screenshot: "iVBORw0KGgo=", screenshotFormat: "png", success: true, title: "Pricing", url: "https://shop.example/pricing" },
            state: "output-available",
            toolCallId: "call-1",
            type: "tool-browser",
        },
    ],
    role: "assistant",
    status: "success",
} as unknown as ChatMessage;

vi.mock("@/features/chat/core/context/chat-context-hooks", () => {
    return {
        useChatMessages: () => {
            return { messages: [reply] };
        },
        useChatThreadIdentity: () => {
            return { threadId: "t1" };
        },
    };
});

const { default: ChatImageGallery } = await import("./chat-image-gallery");
const { useImageGalleryStore } = await import("./image-gallery-store");

describe("a browser screenshot in a reply", () => {
    it("opens its own chat's gallery at it, from under the chat with no header mounted (a split pane without focus)", () => {
        render(
            <ChatImageGallery>
                <MessageContentUI message={reply} />
            </ChatImageGallery>,
        );
        fireEvent.click(screen.getByRole("button", OPEN_SCREENSHOT));

        expect(useImageGalleryStore.getState().shown).toEqual({ key: "tool:m1:call-1", threadId: "t1" });
        expect(screen.getByText("Image 1 of 1")).toBeTruthy();
    });

    it("is a plain image where the app shows no gallery, as in a comparison column", () => {
        render(
            <ChatImageGallery>
                <ImageOpenContext value={null}>
                    <MessageContentUI message={reply} />
                </ImageOpenContext>
            </ChatImageGallery>,
        );

        expect(screen.queryByRole("button", OPEN_SCREENSHOT)).toBeNull();
        expect(screen.getByRole("img", { name: "Pricing" })).toBeTruthy();
    });
});
