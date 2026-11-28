// @vitest-environment jsdom

/** The right sidebar's tabs by the thread's model: Pins for every model (an image chat's images are pinned), Ask for text only. */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const thread = vi.hoisted(() => {
    return { model: "text-model" };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/ui/components/sidebar", () => {
    const Pass = ({ children }: { children?: unknown }) => <div>{children as never}</div>;

    return { Sidebar: Pass, SidebarContent: Pass, SidebarRail: () => null };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: () => {} };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // Any `crpc.<path>.mutationOptions()` the sidebar asks for.
    const node = (): unknown =>
        new Proxy(
            () => {
                return {};
            },
            {
                get: (_target, key) =>
                    key === "mutationOptions"
                        ? () => {
                              return {};
                          }
                        : node(),
            },
        );

    return { useCRPC: () => node() };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return {
        default: () => [
            { id: "text-model", mode: "text" },
            { id: "image-model", mode: "image" },
        ],
    };
});

vi.mock("@/features/chat/model-settings/use-model-combobox", () => {
    return {
        default: () => {
            return { thread: { model: thread.model, summary: undefined } };
        },
    };
});

vi.mock("@/features/chat/aside/aside-panel", () => {
    return { default: () => null };
});

// The context box reads its own queries; the tabs are what these tests are about.
vi.mock("./thread-context", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/pins/pins-sidebar-tab", () => {
    return { default: () => <p>pins tab</p> };
});

vi.mock("@/features/prompts/components/prompts-sidebar-tab", () => {
    return { default: () => null };
});

vi.mock("@/features/prompts/components/thread-variables-config", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/prompt-improvement/components/apply-preset-menu", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog", () => {
    return { default: () => null };
});

const { useChatUIStore } = await import("@/features/chat/core/stores/chat-ui-store");
const { default: ThreadSidebar } = await import("./thread-sidebar");

/** The tab list measures itself with a ResizeObserver, which it constructs. */
class ResizeObserverStub {
    disconnect() {
        return this;
    }

    observe() {
        return this;
    }

    unobserve() {
        return this;
    }
}

describe("ThreadSidebar tabs", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", ResizeObserverStub);
        thread.model = "text-model";
        useChatUIStore.getState().setActiveRightSidebarTab("summary");
    });

    it("offers Pins and Ask in a text chat", () => {
        render(<ThreadSidebar threadId="t1" />);

        expect(screen.getByRole("tab", { name: "Pins" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "Ask" })).toBeTruthy();
    });

    it("offers Pins but not Ask in an image chat, and shows the pins when that tab is chosen", () => {
        thread.model = "image-model";
        useChatUIStore.getState().setActiveRightSidebarTab("pins");
        render(<ThreadSidebar threadId="t1" />);

        expect(screen.getByRole("tab", { name: "Pins" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByRole("tab", { name: "Ask" })).toBeNull();
        expect(screen.getByText("pins tab")).toBeTruthy();
    });
});
