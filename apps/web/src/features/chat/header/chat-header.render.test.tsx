// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { beginTitleSave, settleTitleSave } from "@/features/chat/core/lib/thread-title-saves";
import useThreadStore from "@/features/chat/core/stores/thread-store";

import ChatSiteHeader from "./chat-header";

// The server's copy of the thread's title, as the header's query reads it.
const server = vi.hoisted(() => {
    return { id: "t1", title: "Original" as string };
});

const updateThread = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Trans: ({ children }: { children?: unknown }) => children,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("@neore/ui/components/sidebar", () => {
    return { SidebarTrigger: () => null };
});

vi.mock("@neore/ui/components/theme-toggle", () => {
    return { default: () => null };
});

vi.mock("@/features/auth/components/anonymous/anonymous-user-banner", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/core/hooks/use-threads", () => {
    return { useUpdateThread: () => updateThread };
});

vi.mock("@/features/chat/core/hooks/use-validated-thread", () => {
    return {
        useValidatedThread: () => {
            return {
                actualThreadId: server.id,
                isValid: true,
                threadData: { model: "model-a", title: server.title },
                validThreadId: server.id,
            };
        },
    };
});

vi.mock("@/features/chat/group/group-participant-bar", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/sharing/thread-share-button", () => {
    return { default: () => null };
});

vi.mock("@/features/develop/components/thread-pull-requests", () => {
    return { default: () => null };
});

vi.mock("@/features/layout/components/site-header", () => {
    return { default: ({ children }: { children?: unknown }) => children };
});

vi.mock("./kb-attachment-button", () => {
    return { default: () => null };
});

vi.mock("./temporary-chat-dropdown", () => {
    return { default: () => null };
});

vi.mock("./thread-download-button", () => {
    return { default: () => null };
});

describe("ChatSiteHeader after a rename from the list", () => {
    it("shows the list's new title on the next render, after the header itself has renamed the chat", async () => {
        server.title = "Original";

        const { rerender } = render(<ChatSiteHeader threadId="t1" />);

        // The header renames the chat itself: edit, type, save.
        fireEvent.click(screen.getByText("Original"));
        fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Mine" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Mine")).toBeTruthy();

        // The thread list then renames the chat, through the same save coordinator and metadata as its dialog does.
        const order = beginTitleSave("t1", "Theirs", "Mine", false);
        const shown = settleTitleSave("t1", order, "saved");

        useThreadStore.getState().setThreadMetadata((previous) => {
            const current = previous.get("t1");

            if (!current || shown === undefined) {
                return previous;
            }

            return new Map(previous).set("t1", { ...current, title: shown });
        });
        server.title = "Theirs";

        rerender(<ChatSiteHeader threadId="t1" />);

        expect(screen.getByText("Theirs")).toBeTruthy();
        expect(screen.queryByText("Mine")).toBeNull();
    });

    it("re-renders when a list rename settles, even with no metadata entry for the thread", async () => {
        server.id = "t2";
        server.title = "Old";
        useThreadStore.setState({ threadMetadata: new Map() });

        render(<ChatSiteHeader threadId="t2" />);
        expect(screen.getByText("Old")).toBeTruthy();

        // The list starts a rename: the server has not applied it, so the header still shows the old title.
        let order = 0;

        act(() => {
            order = beginTitleSave("t2", "New", "Old", false);
        });
        expect(screen.getByText("Old")).toBeTruthy();

        // The rename settles. No metadata is written and no prop changes: the header must re-render by itself.
        act(() => {
            settleTitleSave("t2", order, "saved");
        });

        expect(await screen.findByText("New")).toBeTruthy();
    });
});
