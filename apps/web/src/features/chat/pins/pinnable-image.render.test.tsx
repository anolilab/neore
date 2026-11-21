// @vitest-environment jsdom

/** A reply's image gets a pin button that pins that one image; uploads and images not shown get none. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.hoisted(() => vi.fn());
const setActiveRightSidebarTab = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/chat-ui/chat/message-content", () => {
    return {
        DefaultImage: ({ part }: { part: { image: string } }) => <img alt="generated" src={part.image} />,
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    pins: {
                        functions: {
                            createPin: {
                                mutationOptions: () => {
                                    return {};
                                },
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context-hooks", () => {
    return {
        useChatThreadIdentity: () => {
            return { threadId: "k17abc" };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-validated-thread", () => {
    return { isValidThreadId: (id: unknown) => typeof id === "string" && id.length > 0 };
});

vi.mock("@/features/chat/core/stores/chat-ui-store", () => {
    return {
        useChatUIStore: {
            getState: () => {
                return { setActiveRightSidebarTab };
            },
        },
    };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: () => {} };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {} };
});

const { canPinImage, default: PinnableImage, imagePinText } = await import("./pinnable-image");

const PIN_BUTTON = { name: "Pin image" };
const generated = { image: "https://files.example/fox.png", prompt: "A fox logo", type: "image" as const };

describe(canPinImage, () => {
    it("pins a shown image of a reply whose place is known", () => {
        expect(canPinImage({ messageId: "m1", part: generated, imageIndex: 0, messageRole: "assistant" })).toBe(true);
    });

    it.each([
        ["a person's upload", { messageId: "m1", part: generated, imageIndex: 0, messageRole: "user" }],
        ["an image with no known place", { part: generated, messageRole: "assistant" }],
        ["an image still being checked", { messageId: "m1", part: { ...generated, nsfwStatus: "checking" }, imageIndex: 0, messageRole: "assistant" }],
        ["a blocked image", { messageId: "m1", part: { ...generated, nsfwStatus: "blocked" }, imageIndex: 0, messageRole: "assistant" }],
        ["an image with no source", { messageId: "m1", part: { ...generated, image: "" }, imageIndex: 0, messageRole: "assistant" }],
    ])("does not pin %s", (_label, props) => {
        expect(canPinImage(props)).toBe(false);
    });
});

describe(imagePinText, () => {
    it("keeps the prompt, else the file name, else nothing", () => {
        expect(imagePinText({ ...generated, filename: "fox.png" })).toBe("A fox logo");
        expect(imagePinText({ filename: "fox.png", image: "x", type: "image" })).toBe("fox.png");
        expect(imagePinText({ image: "x", prompt: "  ", type: "image" })).toBeUndefined();
    });
});

describe("PinnableImage", () => {
    beforeEach(() => {
        mutate.mockReset();
        setActiveRightSidebarTab.mockReset();
    });

    it("pins the image with its message, part index and prompt", () => {
        render(<PinnableImage imageIndex={3} messageId="m1" messageRole="assistant" part={generated} />);
        fireEvent.click(screen.getByRole("button", PIN_BUTTON));

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(mutate.mock.calls[0]?.[0]).toEqual({
            kind: "image",
            messageId: "m1",
            messageRole: "assistant",
            imageIndex: 3,
            selectedText: "A fox logo",
            threadId: "k17abc",
        });
    });

    it("shows the pin button where nothing can hover, at a full touch target", () => {
        render(<PinnableImage imageIndex={0} messageId="m1" messageRole="assistant" part={generated} />);

        const { className } = screen.getByRole("button", PIN_BUTTON);

        expect(className).toContain("[@media(hover:none)]:opacity-100");
        expect(className).toContain("pointer-coarse:size-11");
    });

    it("opens the pins tab once the pin is saved", () => {
        render(<PinnableImage imageIndex={3} messageId="m1" messageRole="assistant" part={generated} />);
        fireEvent.click(screen.getByRole("button", PIN_BUTTON));
        (mutate.mock.calls[0]?.[1] as { onSuccess: () => void }).onSuccess();

        expect(setActiveRightSidebarTab).toHaveBeenCalledWith("pins");
    });

    it("shows a person's own upload without a pin button", () => {
        render(<PinnableImage imageIndex={0} messageId="m1" messageRole="user" part={generated} />);

        expect(screen.queryByRole("button", PIN_BUTTON)).toBeNull();
        expect(screen.getByRole("img", { name: "generated" }).getAttribute("src")).toBe(generated.image);
    });
});
