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
    return { api: { chat: { functions: { regenerateThreadTitle: {} } } } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: () => {} };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {}, showSuccess: () => {} };
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
});
