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

describe("a browser screenshot in a reply", () => {
    it("opens the gallery at that screenshot", () => {
        const open = vi.fn();

        render(
            <ImageOpenContext value={open}>
                <MessageContentUI message={reply} />
            </ImageOpenContext>,
        );
        fireEvent.click(screen.getByRole("button", OPEN_SCREENSHOT));

        expect(open).toHaveBeenCalledWith("tool:call-1");
    });

    it("is a plain image where the app shows no gallery", () => {
        render(<MessageContentUI message={reply} />);

        expect(screen.queryByRole("button", OPEN_SCREENSHOT)).toBeNull();
        expect(screen.getByRole("img", { name: "Pricing" })).toBeTruthy();
    });
});
