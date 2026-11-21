// @vitest-environment jsdom

/** A gallery item's stored prompt goes into the composer marked, edited or not: not all of it is the person's own words. */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id }, t };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    const messages = [
        { id: "u1", parts: [{ text: "A lighthouse at dusk", type: "text" }], role: "user" },
        {
            id: "a1",
            metadata: { prompt: "A lighthouse at dusk, oil painting" },
            parts: [{ mediaType: "image/png", type: "file", url: "https://x.test/a.png" }],
            role: "assistant",
        },
    ];

    return {
        useChatIsStreaming: () => {
            return { isStreaming: false };
        },
        useChatMessages: () => {
            return { messages };
        },
        useChatThread: () => {
            return { isNewThread: true, thread: undefined, threadId: undefined };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    const models: unknown[] = [];

    return { default: () => models };
});

vi.mock("@/features/chat/components/cinema-studio", () => {
    return { CinemaStudioControls: () => null };
});

// The grid and the preview dialog stand in as plain buttons: what is under test is the prompt they hand back.
vi.mock("@neore/ui/components/image-gallery", () => {
    return {
        ImageGallery: ({ items, onItemClick }: { items: { id: string }[]; onItemClick: (item: unknown) => void }) =>
            items.map((item) => (
                <button key={item.id} onClick={() => onItemClick(item)} type="button">
                    {`Open ${item.id}`}
                </button>
            )),
        ImageGalleryKreaGrid: () => null,
    };
});

vi.mock("@neore/ui/components/media-preview-dialog", () => {
    const Pass = ({ children }: { children?: ReactNode }) => children;

    return {
        MediaPreviewDialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
        MediaPreviewDialogContent: Pass,
        MediaPreviewDialogFooter: ({ children, onSubmit, submitLabel }: { children: ReactNode; onSubmit: () => void; submitLabel: string }) => (
            <>
                {children}
                <button onClick={onSubmit} type="button">
                    {submitLabel}
                </button>
            </>
        ),
        MediaPreviewPanel: () => null,
        MediaPreviewSettingsPanel: Pass,
    };
});

const { default: MediaGalleryView } = await import("./media-gallery-view");

beforeEach(() => {
    useChatUIStore.getState().reset();
    useModelStore.setState({ newThreadMode: "image" });
});

describe("MediaGalleryView", () => {
    it("marks the composer's draft when an item's prompt is sent on, even after an edit", () => {
        render(<MediaGalleryView />);

        fireEvent.click(screen.getByRole("button", { name: "Open a1-0" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "A lighthouse at dawn, oil painting" } });
        fireEvent.click(screen.getByRole("button", { name: "Generate Image" }));

        expect(useChatUIStore.getState().composerText).toBe("A lighthouse at dawn, oil painting");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("galleryPrompt");
    });
});
