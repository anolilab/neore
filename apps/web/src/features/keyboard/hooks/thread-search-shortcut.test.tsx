/**
 * Focus Search against the real thread-list header and search bar, driven by a real
 * keydown through the keyboard manager, so a selector that matches nothing fails here.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import ThreadListHeader from "@/features/chat/thread-list/thread-list-header";
import { KeyboardShortcutsManager } from "@/features/keyboard/components/keyboard-shortcuts-manager";

import useKeyboardShortcutHandler from "./use-keyboard-shortcut-handler";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
// The sheet uses the lingui macro, which these tests do not compile; it has its own coverage.
vi.mock("../components/keyboard-shortcuts-sheet", () => {
    return { default: () => null };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => vi.fn(),
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useActiveOrganization: () => {
                        return { data: undefined };
                    },
                    useListOrganizations: () => {
                        return { data: [] };
                    },
                },
            };
        },
    };
});

// Backend-bound children the search does not depend on.
vi.mock("@/features/auth/components/organization/organization-switcher", () => {
    return {
        default: () => null,
    };
});
vi.mock("@/features/auth/components/team/team-switcher", () => {
    return {
        default: () => null,
    };
});
vi.mock("@/features/chat/group/create-group-chat-button", () => {
    return {
        default: () => null,
    };
});
vi.mock("@/features/chat/tags/thread-category-filter", () => {
    return {
        default: () => null,
    };
});
vi.mock("@/features/chat/tags/thread-tag-filter", () => {
    return {
        default: () => null,
    };
});

const Shortcuts = ({ children }: { children?: ReactNode }) => {
    const onShortcut = useKeyboardShortcutHandler();

    return (
        <KeyboardShortcutsManager onShortcut={onShortcut} shortcuts={{ findInThread: "ctrl+shift+9", focusSearch: "ctrl+f" }}>
            {children}
        </KeyboardShortcutsManager>
    );
};

const SEARCH_PLACEHOLDER = "Search thread titles...";

const pressFocusSearch = (target: Element = document.body): boolean => fireEvent.keyDown(target, { code: "KeyF", ctrlKey: true, key: "f" });

describe("Focus Search shortcut", () => {
    beforeEach(() => {
        useThreadListUIStore.getState().reset();
    });

    it("opens a closed search bar and focuses its input", () => {
        render(
            <Shortcuts>
                <ThreadListHeader />
            </Shortcuts>,
        );

        expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();

        const notPrevented = pressFocusSearch();

        // eslint-disable-next-line testing-library/no-node-access -- Testing Library has no focus query
        expect(document.activeElement).toBe(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));
        expect(notPrevented).toBe(false);
    });

    it("moves focus to the input of a search bar that is already open", () => {
        render(
            <Shortcuts>
                <ThreadListHeader />
                <button type="button">elsewhere</button>
            </Shortcuts>,
        );

        act(() => {
            useThreadListUIStore.getState().setShowSearch(true);
        });

        screen.getByRole("button", { name: "elsewhere" }).focus();
        pressFocusSearch();

        // eslint-disable-next-line testing-library/no-node-access -- Testing Library has no focus query
        expect(document.activeElement).toBe(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));
        expect(useThreadListUIStore.getState().showSearch).toBe(true);
    });

    it("leaves the keystroke to the browser's find when the sidebar holding the search is collapsed", () => {
        render(
            <Shortcuts>
                <div data-slot="sidebar" data-state="collapsed">
                    <ThreadListHeader />
                </div>
            </Shortcuts>,
        );

        expect(pressFocusSearch()).toBe(true);
        expect(useThreadListUIStore.getState().showSearch).toBe(false);
    });

    it("leaves the keystroke to the browser's find when the page has no thread search", () => {
        render(
            <Shortcuts>
                <button type="button">elsewhere</button>
            </Shortcuts>,
        );

        const notPrevented = pressFocusSearch();

        expect(notPrevented).toBe(true);
    });
});
