// @vitest-environment jsdom

/** The row's options menu offers "Open in split view" only while the split view preference hands it a handler. */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: { regenerateThreadTitle: {} }, side_chat: { createSideChat: {} } } } };
});

const sideChat = vi.hoisted(() => {
    return { openChat: vi.fn(), result: { reason: "locked", status: "refused" } as { reason?: string; status: string; threadId?: string }, showError: vi.fn() };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return {
                isPending: false,
                mutate: (_input: unknown, callbacks?: { onSuccess?: (result: unknown) => void }) => callbacks?.onSuccess?.(sideChat.result),
            };
        },
    };
});

vi.mock("../split/use-open-chat", () => {
    return { useOpenChatClick: () => sideChat.openChat };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: sideChat.showError, showSuccess: () => {} };
});

const follow = vi.hoisted(() => {
    return {
        error: null as Error | null,
        isPending: false,
        setState: vi.fn(),
        state: "off" as "on" | "off" | "muted" | undefined,
    };
});

vi.mock("../follows/use-thread-follow", () => {
    return {
        useThreadFollow: () => {
            return { error: follow.error, isPending: follow.isPending, setState: follow.setState, state: follow.state };
        },
    };
});

const { default: ThreadOptionsMenu } = await import("./thread-options-menu");

const OPEN_IN_SPLIT_VIEW = { name: "Open in split view" };

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

const renderMenu = (onOpenInSplitView?: () => void) =>
    render(
        <ThreadOptionsMenu
            isHostRun={false}
            isLocked={false}
            label="Quarterly plan"
            onOpenChange={() => {}}
            onOpenInSplitView={onOpenInSplitView}
            onRename={() => {}}
            open
            threadId="t1"
        />,
    );

describe("ThreadOptionsMenu", () => {
    beforeEach(() => {
        // An open menu positions itself with a ResizeObserver, which it constructs.
        vi.stubGlobal("ResizeObserver", ResizeObserverStub);
        vi.stubGlobal("matchMedia", (query: string) => {
            return { addEventListener: () => {}, matches: false, media: query, removeEventListener: () => {} };
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("lists Open in split view when a handler is given", () => {
        renderMenu(() => {});

        expect(screen.getByRole("menuitem", OPEN_IN_SPLIT_VIEW)).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    });

    it("leaves the item out when no handler is given", () => {
        renderMenu();

        expect(screen.queryByRole("menuitem", OPEN_IN_SPLIT_VIEW)).toBeNull();
        expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    });

    it("calls the handler when the item is clicked", () => {
        const onOpenInSplitView = vi.fn();

        renderMenu(onOpenInSplitView);
        fireEvent.click(screen.getByRole("menuitem", OPEN_IN_SPLIT_VIEW));

        expect(onOpenInSplitView).toHaveBeenCalledTimes(1);
    });

    describe("side chat", () => {
        beforeEach(() => {
            sideChat.openChat.mockReset();
            sideChat.showError.mockReset();
        });

        it("opens the new thread when the side chat starts", () => {
            sideChat.result = { status: "ok", threadId: "side1" };
            renderMenu();
            fireEvent.click(screen.getByRole("menuitem", { name: "Side chat" }));

            expect(sideChat.openChat).toHaveBeenCalledWith("side1", expect.objectContaining({ button: 0, ctrlKey: false, metaKey: false }), "t1");
            expect(sideChat.showError).not.toHaveBeenCalled();
        });

        it.each([
            ["archived", "An archived chat cannot start a side chat."],
            ["custom_endpoint", "A chat on a custom endpoint cannot start a side chat."],
            ["empty", "Send a message and wait for the reply before starting a side chat."],
            ["shared", "A shared or temporary chat cannot start a side chat."],
            ["host_run", "A chat that runs on your computer cannot start a side chat."],
            ["locked", "Unlock this chat to start a side chat."],
            ["not_found", "This chat cannot start a side chat."],
        ])("says why a %s chat is refused", (reason, message) => {
            sideChat.result = { reason, status: "refused" };
            renderMenu();
            fireEvent.click(screen.getByRole("menuitem", { name: "Side chat" }));

            expect(sideChat.showError).toHaveBeenCalledWith(message);
            expect(sideChat.openChat).not.toHaveBeenCalled();
        });
    });

    describe("follow items", () => {
        beforeEach(() => {
            follow.error = null;
            follow.isPending = false;
            follow.setState.mockReset();
        });

        it("offers Follow and Mute while the thread is not followed", () => {
            follow.state = "off";
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Follow thread" })).toBeTruthy();
            expect(screen.getByRole("menuitem", { name: "Mute thread" })).toBeTruthy();
            expect(screen.queryByRole("menuitem", { name: "Unfollow thread" })).toBeNull();
        });

        it("offers Unfollow and Mute while the thread is followed", () => {
            follow.state = "on";
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Unfollow thread" })).toBeTruthy();
            expect(screen.getByRole("menuitem", { name: "Mute thread" })).toBeTruthy();
            expect(screen.queryByRole("menuitem", { name: "Follow thread" })).toBeNull();
        });

        it("offers Follow and Unfollow while the thread is muted", () => {
            follow.state = "muted";
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Follow thread" })).toBeTruthy();
            expect(screen.getByRole("menuitem", { name: "Unfollow thread" })).toBeTruthy();
            expect(screen.queryByRole("menuitem", { name: "Mute thread" })).toBeNull();
        });

        it("shows no follow item until the state has loaded", () => {
            follow.state = undefined;
            renderMenu();

            expect(screen.queryByRole("menuitem", { name: "Follow thread" })).toBeNull();
            expect(screen.queryByRole("menuitem", { name: "Mute thread" })).toBeNull();
        });

        it("says the follow state could not be loaded, instead of hiding the items", () => {
            follow.state = undefined;
            follow.error = new Error("network");
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Couldn't load follow state" }).getAttribute("aria-disabled")).toBe("true");
            expect(screen.queryByRole("menuitem", { name: "Follow thread" })).toBeNull();
        });

        it("offers no follow choice from a cached state while the refetch fails", () => {
            follow.state = "off";
            follow.error = new Error("network");
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Couldn't load follow state" })).toBeTruthy();
            expect(screen.queryByRole("menuitem", { name: "Follow thread" })).toBeNull();
            expect(screen.queryByRole("menuitem", { name: "Mute thread" })).toBeNull();
        });

        it("disables the follow items while a change is in flight", () => {
            follow.state = "off";
            follow.isPending = true;
            renderMenu();

            expect(screen.getByRole("menuitem", { name: "Follow thread" }).getAttribute("aria-disabled")).toBe("true");
            expect(screen.getByRole("menuitem", { name: "Mute thread" }).getAttribute("aria-disabled")).toBe("true");
        });

        it("sets the chosen state when an item is clicked", () => {
            follow.state = "off";
            renderMenu();
            fireEvent.click(screen.getByRole("menuitem", { name: "Mute thread" }));

            expect(follow.setState).toHaveBeenCalledWith("muted");
        });
    });
});
