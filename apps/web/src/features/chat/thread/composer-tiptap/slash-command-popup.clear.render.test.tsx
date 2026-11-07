/**
 * `/clear` from the slash menu removes the command only once the reset is written, and only from the draft it was run
 * from: a draft edited, or another chat shown, while the request was out stays as it is.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashCommandMatch } from "./extensions/slash-command";
import SlashCommandPopup from "./slash-command-popup";

const harness = vi.hoisted(() => {
    return { clears: [] as ((cleared: boolean) => void)[] };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id }, t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});

vi.mock("@/components/model-picker/model-picker-popup-store", () => {
    return {
        useModelPickerPopupActions: () => {
            return { open: vi.fn() };
        },
    };
});

vi.mock("@/features/chat/compaction/use-compact-thread", () => {
    return {
        default: () => {
            return { compact: vi.fn(), isCompacting: false };
        },
    };
});

// The clear is out until the test answers it.
vi.mock("@/features/chat/context-reset/use-clear-context", () => {
    return {
        default: () => {
            return {
                clear: async () =>
                    await new Promise<boolean>((resolve) => {
                        harness.clears.push(resolve);
                    }),
                isClearing: false,
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return { mutationFn: async () => [] };
        },
    };
});

const RECT = new DOMRect(0, 400, 600, 0);

const matchOf = (text: string): SlashCommandMatch => {
    return { command: text === "/clear" ? "clear" : undefined, from: 1, query: "", startOffset: 0, text, to: 1 + text.length, wholeDraft: true };
};

const client = new QueryClient();

const popup = (
    match: SlashCommandMatch,
    threadId: string,
    handlers: { onDismiss: () => void; onReplace: (from: number, to: number, text: string) => void; readDraft: () => string },
) => (
    <QueryClientProvider client={client}>
        <SlashCommandPopup
            currentThreadId={threadId}
            editorRect={RECT}
            favoriteModelIds={[]}
            match={match}
            models={[]}
            onDismiss={handlers.onDismiss}
            onReplace={handlers.onReplace}
            readDraft={handlers.readDraft}
        />
    </QueryClientProvider>
);

/**
 * Runs Clear from the menu showing `typed` in thread `a`. While the request is out the editor holds `draft`; `next` (when
 * given) is the match the menu has been told of by then, in `nextThread`.
 */
const runClear = async (options: { draft: string; next?: SlashCommandMatch; nextThread?: string; typed?: string }) => {
    const handlers = { onDismiss: vi.fn(), onReplace: vi.fn(), readDraft: () => options.draft };
    const typed = matchOf(options.typed ?? "/c");
    const view = render(popup(typed, "a", handlers));

    fireEvent.click(screen.getByText("/clear"));

    if (options.next) {
        view.rerender(popup(options.next, options.nextThread ?? "a", handlers));
    }

    await act(async () => {
        harness.clears.at(-1)?.(true);
        await Promise.resolve();
    });

    return handlers;
};

// The menu's scroll area constructs a ResizeObserver, which the shared setup's stand-in cannot be, and its transitions read
// `getAnimations`, which jsdom lacks.
beforeEach(() => {
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    vi.stubGlobal(
        "ResizeObserver",
        class {
            public disconnect = vi.fn();

            public observe = vi.fn();

            public unobserve = vi.fn();
        },
    );
});

afterEach(() => {
    harness.clears = [];
});

describe("Clear from the slash menu", () => {
    it("removes the command once the reset is written", async () => {
        expect.assertions(2);

        const { onDismiss, onReplace } = await runClear({ draft: "/c" });

        expect(onReplace).toHaveBeenCalledWith(1, 3, "");
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it("leaves a draft edited while the request was out, and the menu open", async () => {
        expect.assertions(2);

        const { onDismiss, onReplace } = await runClear({ draft: "/m", next: matchOf("/m") });

        expect(onReplace).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("leaves an edit the menu has not been told of yet: the editor's own text decides", async () => {
        expect.assertions(2);

        const { onDismiss, onReplace } = await runClear({ draft: "/cx" });

        expect(onReplace).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("leaves another chat's draft, even the same text", async () => {
        expect.assertions(2);

        const { onDismiss, onReplace } = await runClear({ draft: "/c", next: matchOf("/c"), nextThread: "b" });

        expect(onReplace).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("does not run from a slash text that is not the start of /clear", async () => {
        expect.assertions(2);

        const { onReplace } = await runClear({ draft: "/m", typed: "/m" });

        expect(harness.clears).toHaveLength(0);
        expect(onReplace).not.toHaveBeenCalled();
    });
});
