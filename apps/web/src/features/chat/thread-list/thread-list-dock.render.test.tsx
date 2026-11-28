// @vitest-environment jsdom

/** The dock: the search field, the filter menu, "Add project" and "New Thread" keep the names the old header buttons had. */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/native/bridge", () => {
    return { getAddProjectBridge: () => undefined };
});

// The dialog stands in as a marker that shows while the dock holds it open.
vi.mock("@/features/chat/group/create-group-chat-button", () => {
    return { default: ({ open }: { open?: boolean }) => (open ? <div role="dialog">New group chat dialog</div> : null) };
});

vi.mock("@/features/chat/tags/thread-categories", () => {
    return { THREAD_CATEGORY_LABELS: { coding: "Coding" } };
});

vi.mock("@/features/chat/tags/use-thread-tags", () => {
    return { useThreadTags: () => [] };
});

const KEYBOARD_SHORTCUTS_NAME = /Keyboard shortcuts/u;

const { default: ThreadListDock } = await import("./thread-list-dock");
const { useThreadListUIStore } = await import("./stores/thread-list-ui-store");

const MAC_KEY_SYMBOL = /[⌃⇧⌥⌘]/u;

describe("ThreadListDock", () => {
    beforeEach(() => {
        localStorage.clear();
        useThreadListUIStore.getState().reset();
        // An open menu positions itself with a ResizeObserver, which it constructs.
        vi.stubGlobal(
            "ResizeObserver",
            class {
                disconnect = vi.fn();

                observe = vi.fn();

                unobserve = vi.fn();
            },
        );
    });

    afterEach(() => {
        cleanup();
        navigate.mockClear();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each(["Search threads", "Search filters", "Add project", "New Thread"])("names the %s button", (name) => {
        render(<ThreadListDock />);

        expect(screen.getByRole("button", { name })).toBeTruthy();
    });

    // The store keeps the platform modifier as "ctrl", which is Command on a Mac.
    it("prints the search shortcut with key symbols on a Mac, Command for the platform modifier", () => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
        render(<ThreadListDock />);

        expect(screen.getByText("⌘⇧F")).toBeTruthy();
    });

    it("prints no Mac key symbols elsewhere, where the chord is too long for the hint and stays in the tooltip", () => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
        render(<ThreadListDock />);

        expect(screen.queryByText(MAC_KEY_SYMBOL)).toBeNull();
    });

    it("names the closed search button for message search when that mode is selected", () => {
        act(() => {
            useThreadListUIStore.getState().setSearchType("messages");
        });
        render(<ThreadListDock />);

        expect(screen.getByRole("button", { name: "Search messages" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Search threads" })).toBeNull();
    });

    it("keeps the search toggle hook on the field's button, and opens the input in its place", () => {
        render(<ThreadListDock />);

        const toggle = screen.getByRole("button", { name: "Search threads" });

        expect(Object.hasOwn(toggle.dataset, "searchToggle")).toBe(true);

        fireEvent.click(toggle);

        const input = screen.getByRole("textbox", { name: "Search thread titles and summaries" });

        expect(Object.hasOwn(input.dataset, "searchInput")).toBe(true);
        expect(Object.hasOwn(screen.getByRole("button", { name: "Close search" }).dataset, "searchToggle")).toBe(true);
        expect(screen.queryByRole("button", { name: "Search threads" })).toBeNull();
    });

    it("types into the store's query and hides the section bar while a query is typed", () => {
        act(() => {
            useThreadListUIStore.getState().setShowSearch(true);
        });
        render(<ThreadListDock />);

        expect(screen.getByRole("group", { name: "Thread sections (shift-click to show several)" })).toBeTruthy();

        fireEvent.change(screen.getByRole("textbox"), { target: { value: "budget" } });

        expect(useThreadListUIStore.getState().searchQuery).toBe("budget");
        expect(screen.queryByRole("group", { name: "Thread sections (shift-click to show several)" })).toBeNull();
    });

    it("opens the add project dialog and goes to a new thread", () => {
        render(<ThreadListDock />);

        fireEvent.click(screen.getByRole("button", { name: "Add project" }));

        expect(useThreadListUIStore.getState().showProjectFormDialog).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "New Thread" }));

        expect(navigate).toHaveBeenCalledWith({ search: {}, to: "/chat" });
    });

    describe("its filter menu", () => {
        const openMenu = async () => {
            const user = userEvent.setup();

            render(<ThreadListDock />);
            await user.click(screen.getByRole("button", { name: "Search filters" }));
            await screen.findByRole("menu");

            return user;
        };

        it("holds what to search in, the filters and the list-wide actions", async () => {
            await openMenu();

            expect(screen.getByRole("menuitemradio", { name: "Threads" })).toBeTruthy();
            expect(screen.getByRole("menuitemradio", { name: "Messages" })).toBeTruthy();

            for (const name of ["Category", "Tags", "New group chat", "Select multiple threads", "Keyboard shortcuts"]) {
                expect(screen.getByRole("menuitem", { name: new RegExp(name, "u") })).toBeTruthy();
            }
        });

        it("switches the search to messages", async () => {
            const user = await openMenu();

            await user.click(screen.getByRole("menuitemradio", { name: "Messages" }));

            expect(useThreadListUIStore.getState().searchType).toBe("messages");
        });

        it("enters selection mode, shows the shortcuts and opens the group chat dialog outside the menu", async () => {
            const user = await openMenu();

            await user.click(screen.getByRole("menuitem", { name: "Select multiple threads" }));

            expect(useThreadListUIStore.getState().isSelectionMode).toBe(true);

            await user.click(screen.getByRole("button", { name: "Search filters" }));
            await user.click(await screen.findByRole("menuitem", { name: KEYBOARD_SHORTCUTS_NAME }));

            expect(useThreadListUIStore.getState().showKeyboardHelp).toBe(true);

            await user.click(screen.getByRole("button", { name: "Search filters" }));
            await user.click(await screen.findByRole("menuitem", { name: "New group chat" }));

            expect(screen.getByRole("dialog", { name: undefined }).textContent).toBe("New group chat dialog");
        });
    });
});
