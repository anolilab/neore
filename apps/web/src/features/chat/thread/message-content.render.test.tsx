/**
 * chat-ui's MessageContent across re-renders: a tool call row must stay mounted
 * (and keep its expanded state) when the message around it changes.
 */

import MessageContentUI from "@neore/chat-ui/chat/message-content";
import type { ChatMessage } from "@neore/chat-ui/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Unit tests do not compile the Lingui macros; chat-ui's rows call `useLingui`.
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

const LOOKUP_BUTTON = /lookup/u;

const message = (text: string): ChatMessage =>
    ({
        id: "m1",
        parts: [
            { input: { query: "weather" }, output: { ok: true }, state: "output-available", toolCallId: "call-1", type: "tool-lookup" },
            { text, type: "text" },
        ],
        role: "assistant",
        status: "success",
    }) as unknown as ChatMessage;

describe("message content tool call rows", () => {
    it("keeps a tool call expanded when the message re-renders", () => {
        const { rerender } = render(<MessageContentUI message={message("first")} />);

        fireEvent.click(screen.getByRole("button", { name: LOOKUP_BUTTON }));

        expect(screen.getByRole("button", { name: LOOKUP_BUTTON }).getAttribute("aria-expanded")).toBe("true");

        rerender(<MessageContentUI message={message("first, then more")} />);

        // A fresh component type per render remounted the row and collapsed it.
        expect(screen.getByRole("button", { name: LOOKUP_BUTTON }).getAttribute("aria-expanded")).toBe("true");
    });
});
