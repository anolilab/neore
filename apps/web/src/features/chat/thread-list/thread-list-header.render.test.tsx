// @vitest-environment jsdom

/** The header's search, create-project, shortcuts and bulk-actions buttons are icons only. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => () => {} };
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

vi.mock("@/features/auth/components/organization/organization-switcher", () => {
    return { default: () => null };
});

vi.mock("@/features/auth/components/team/team-switcher", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/group/create-group-chat-button", () => {
    return { default: () => null };
});

vi.mock("./search-bar", () => {
    return { default: () => null };
});

vi.mock("./stores/thread-list-ui-store", () => {
    return {
        useThreadListUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
            selector({
                enterSelectionMode: () => {},
                openCreateProjectDialog: () => {},
                searchQuery: "",
                searchType: "threads",
                selectedCategory: undefined,
                setSearchQuery: () => {},
                setSearchType: () => {},
                setSelectedCategory: () => {},
                showSearch: false,
                toggleShowKeyboardHelp: () => {},
                toggleShowSearch: () => {},
            }),
    };
});

const { default: ThreadListHeader } = await import("./thread-list-header");

describe("ThreadListHeader", () => {
    it.each(["Search threads", "Create project", "Keyboard shortcuts", "Bulk actions"])("names the %s button", (name) => {
        render(<ThreadListHeader />);

        expect(screen.getByRole("button", { name })).toBeTruthy();
    });
});
