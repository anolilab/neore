// @vitest-environment jsdom

/**
 * A reply's images can be pinned only where the pin lands in this chat's pins: not while the reply streams (it has no
 * saved id yet) and not in a comparison column (another thread). Those callers pass `pinImages={false}`.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => {
    return { components: [] as Record<string, unknown>[] };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@neore/chat-ui/chat/message-content", () => {
    return {
        default: ({ components }: { components: Record<string, unknown> }) => {
            rendered.components.push(components);

            return null;
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useQueryClient: () => {
            return {};
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {};
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-mcp-tool-meta", () => {
    return { default: () => undefined };
});

vi.mock("@/features/chat/link-preview/link-preview-slot", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/pins/pinnable-image", () => {
    return { default: () => null };
});

const { default: PinnableImage } = await import("@/features/chat/pins/pinnable-image");
const { default: MessageContent } = await import("./message-content");

const reply = { id: "m1", parts: [{ text: "Here it is.", type: "text" }], role: "assistant" } as never;

describe("MessageContent image pins", () => {
    beforeEach(() => {
        rendered.components = [];
    });

    it("renders a reply's images as pinnable by default", () => {
        render(<MessageContent message={reply} />);

        expect(rendered.components.at(-1)?.Image).toBe(PinnableImage);
    });

    it("leaves the default image renderer where pins are off", () => {
        render(<MessageContent message={reply} pinImages={false} />);

        expect(rendered.components.at(-1)).not.toHaveProperty("Image");
    });
});
