/**
 * The copy shortcut: the Clipboard API can be missing (an insecure context) or
 * reject the write, and both must reach the same error toast, not throw.
 */
import { act, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CopyLastCodeBlockListener from "./copy-last-code-block";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } };
});

const { chatMessages } = vi.hoisted(() => {
    return { chatMessages: { current: [] as unknown[] } };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: chatMessages.current };
        },
    };
});

const CODE_REPLY = [
    {
        id: "reply-1",
        parts: [{ text: "Here you go:\n```ts\nconst answer = 42;\n```", type: "text" }],
        role: "assistant",
    },
];

const press = () => {
    act(() => {
        globalThis.dispatchEvent(new Event("copyLastCodeBlock"));
    });
};

const setClipboard = (value: unknown) => {
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value });
};

beforeEach(() => {
    chatMessages.current = CODE_REPLY;
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
});

afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
});

describe("copy last code block shortcut", () => {
    it("reports an error toast, without throwing, when the Clipboard API is unavailable", () => {
        setClipboard(undefined);
        render(<CopyLastCodeBlockListener />);

        expect(() => {
            press();
        }).not.toThrow();
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.success).not.toHaveBeenCalled();
    });

    it("reports the same error toast when the clipboard write rejects", async () => {
        setClipboard({
            writeText: vi.fn(async () => {
                throw new Error("denied");
            }),
        });
        render(<CopyLastCodeBlockListener />);

        press();
        await vi.waitFor(() => {
            expect(toast.error).toHaveBeenCalledTimes(1);
        });
        expect(toast.success).not.toHaveBeenCalled();
    });

    it("copies the last code block and confirms it", async () => {
        const writeText = vi.fn(async () => {});

        setClipboard({ writeText });
        render(<CopyLastCodeBlockListener />);

        press();
        await vi.waitFor(() => {
            expect(toast.success).toHaveBeenCalledTimes(1);
        });
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining("const answer = 42;"));
    });
});
