/**
 * The card of a `delegateToSubAgent` call: a sub-agent waiting on its owner's approval says so, shows no spinner, and
 * shows its requests (answered on the child's thread) with a link to that thread. The link opens the thread where the
 * setting says: the side panel by default, and the other place for Ctrl, Cmd or the middle button.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        isDesktop: true,
        navigate: vi.fn(async (_options: unknown) => undefined),
        openBeside: vi.fn(async (_threadId: string, _originThreadId?: string) => "opened" as string),
        requestComposerFocus: vi.fn((_threadId: string) => undefined),
        preferences: { splitViewEnabled: true, subAgentOpenPlace: undefined as unknown },
        run: undefined as Record<string, unknown> | undefined,
        showInSplitView: vi.fn(async (_threadId: string) => undefined),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: () => {
            return { isPending: false, mutate: () => {} };
        },
        useQuery: () => {
            return { data: harness.run, isPending: false };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({
            children,
            onAuxClick,
            onClick,
            params,
        }: {
            children: unknown;
            onAuxClick?: (event: unknown) => void;
            onClick?: (event: unknown) => void;
            params: { threadId: string };
        }) => createElement("a", { href: `/chat/${params.threadId}`, onAuxClick, onClick }, children as never),
        useNavigate: () => harness.navigate,
    };
});

vi.mock("@/features/layout/stores/ui-state-store", () => {
    const useUIStateStore = Object.assign((selector: (state: { preferences: unknown }) => unknown) => selector({ preferences: harness.preferences }), {
        getState: () => {
            return { preferences: harness.preferences };
        },
    });

    return { useUIStateStore };
});

vi.mock("@/features/chat/split/desktop-layout", () => {
    return { isDesktopNow: () => harness.isDesktop, useIsDesktop: () => harness.isDesktop };
});

vi.mock("@/features/chat/split/focus-composer", () => {
    return {
        requestComposerFocus: (threadId: string) => harness.requestComposerFocus(threadId),
    };
});

vi.mock("@/features/chat/split/split-layout-store", () => {
    return {
        openThreadBesideFocusedPane: (threadId: string, originThreadId?: string) => harness.openBeside(threadId, originThreadId),
        showThreadInSplitView: (threadId: string) => harness.showInSplitView(threadId),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const options = () => {
        return {};
    };

    return {
        useCRPC: () => {
            return { sub_agents: { functions: { cancelRun: { mutationOptions: options }, getRunByToolCall: { queryOptions: options } } } };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {} };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { threadId: "parent-1" };
        },
    };
});

vi.mock("./sub-agent-approvals", () => {
    return {
        default: ({ parentThreadId, runId }: { parentThreadId: string; runId: string }) =>
            createElement("p", { "data-testid": "sub-agent-approvals" }, `${parentThreadId}/${runId}`),
    };
});

const { default: SubAgentToolView } = await import("./sub-agent-tool-view");

const part = { input: { task: "Delete the old files" }, state: "output-available", toolCallId: "call-1" } as never;

const renderRunningCard = () => {
    harness.run = { _id: "run-1", childThreadId: "child-1", error: null, status: "running", task: "Delete the old files" };

    render(createElement(SubAgentToolView, { part }));

    return { link: screen.getByRole("link", { name: "Open the sub-agent's thread" }) };
};

// testing-library has no auxclick helper: the middle button is an `auxclick` MouseEvent with the button set.
const auxClick = (element: Element, button: number): boolean => fireEvent(element, new MouseEvent("auxclick", { bubbles: true, button, cancelable: true }));

const MAIN_VIEW = { params: { threadId: "child-1" }, search: {}, to: "/chat/$threadId" };

describe("a sub-agent's card", () => {
    it("says a waiting sub-agent needs the owner's approval, with no spinner, its requests from this conversation and a link to its thread", () => {
        harness.run = { _id: "run-1", childThreadId: "child-1", error: null, status: "awaiting", task: "Delete the old files" };

        render(createElement(SubAgentToolView, { part }));

        expect(screen.getByRole("status").textContent).toBe("Waiting for your approval");
        expect(screen.queryByTestId("sub-agent-spinner")).toBeNull();
        expect(screen.getByTestId("sub-agent-approvals").textContent).toBe("parent-1/run-1");
        expect(screen.getByRole("link", { name: "Open the sub-agent's thread" }).getAttribute("href")).toBe("/chat/child-1");
    });

    it("shows a working sub-agent as working, with its spinner", () => {
        harness.run = { _id: "run-1", childThreadId: "child-1", error: null, status: "running", task: "Delete the old files" };

        render(createElement(SubAgentToolView, { part }));

        expect(screen.getByRole("status").textContent).toBe("Working");
        expect(screen.getByTestId("sub-agent-spinner")).toBeTruthy();
        // Between two steps it takes no answer: its requests show again once it waits.
        expect(screen.queryByTestId("sub-agent-approvals")).toBeNull();
    });
});

describe("where a sub-agent's chat opens", () => {
    beforeEach(() => {
        harness.isDesktop = true;
        harness.navigate.mockClear();
        harness.openBeside.mockClear();
        harness.openBeside.mockResolvedValue("opened");
        harness.showInSplitView.mockClear();
        harness.requestComposerFocus.mockClear();
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: undefined };
    });

    it("opens the side panel on a click by default, when the split view is on", () => {
        const { link } = renderRunningCard();

        // The click is taken by the card, so the browser does not follow the link.
        expect(fireEvent.click(link)).toBe(false);

        expect(harness.openBeside).toHaveBeenCalledWith("child-1", "parent-1");
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("opens the main view by default on a narrow screen, where the side panel is not laid out beside the chat", async () => {
        harness.isDesktop = false;
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("opens the main view on a click once the setting is the main view, and focuses the chat's pane first", async () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
        // A route that already names the chat does not move focus: the pane is shown before the route is read.
        expect(harness.showInSplitView).toHaveBeenCalledWith("child-1");
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("takes the main view with Ctrl when the side panel is the setting", async () => {
        const { link } = renderRunningCard();

        fireEvent.click(link, { ctrlKey: true });

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("takes the side panel with Ctrl when the main view is the setting", () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        const { link } = renderRunningCard();

        fireEvent.click(link, { ctrlKey: true });

        expect(harness.openBeside).toHaveBeenCalledWith("child-1", "parent-1");
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("takes the main view with the middle button when the side panel is the setting, and stops the browser's new tab", async () => {
        const { link } = renderRunningCard();

        expect(auxClick(link, 1)).toBe(false);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("leaves the right button to the browser, so its menu still opens", () => {
        const { link } = renderRunningCard();

        expect(auxClick(link, 2)).toBe(true);

        expect(harness.navigate).not.toHaveBeenCalled();
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("leaves Shift-click and Alt-click to the browser, so a new window or a download still happens", () => {
        const { link } = renderRunningCard();

        expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
        expect(fireEvent.click(link, { altKey: true })).toBe(true);
        // The same holds for the middle button with Shift or Alt: the browser opens the new window, not the placement.
        expect(fireEvent(link, new MouseEvent("auxclick", { altKey: true, bubbles: true, button: 1, cancelable: true }))).toBe(true);
        expect(fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true, shiftKey: true }))).toBe(true);

        expect(harness.navigate).not.toHaveBeenCalled();
        expect(harness.openBeside).not.toHaveBeenCalled();
    });

    it("opens the main view when the saved layout cannot be read, so the link still works", async () => {
        harness.openBeside.mockRejectedValueOnce(new Error("storage unavailable"));
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
    });

    it("still opens the main view when showing the pane fails on the main view", async () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        harness.showInSplitView.mockRejectedValueOnce(new Error("storage unavailable"));
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
    });

    it("opens the main view when the window narrows while its pane opens, so the address names the chat shown", async () => {
        harness.openBeside.mockImplementationOnce(async () => {
            harness.isDesktop = false;

            return "opened";
        });
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
    });

    it("opens the main view when the split view is turned off while its pane opens, so the chat stays visible", async () => {
        harness.openBeside.mockImplementationOnce(async () => {
            harness.preferences = { splitViewEnabled: false, subAgentOpenPlace: undefined };

            return "opened";
        });
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
    });

    it("asks the opened pane for its composer on a keyboard activation, so focus reaches the chat", async () => {
        const { link } = renderRunningCard();

        // A keyboard activation of a link is a click with no detail (0); a mouse click has a detail of at least 1.
        fireEvent.click(link, { detail: 0 });

        await vi.waitFor(() => {
            expect(harness.requestComposerFocus).toHaveBeenCalledWith("child-1");
        });
    });

    it("leaves focus where it is after a mouse click", async () => {
        const { link } = renderRunningCard();

        fireEvent.click(link, { detail: 1 });

        await vi.waitFor(() => {
            expect(harness.openBeside).toHaveBeenCalled();
        });
        expect(harness.requestComposerFocus).not.toHaveBeenCalled();
    });

    it("opens the main view when every pane is taken, where the chat always opened, showing its pane first", async () => {
        harness.openBeside.mockResolvedValue("full");
        const { link } = renderRunningCard();

        fireEvent.click(link);

        await vi.waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        });
        // The route may already name the chat, so the pane is shown before the navigation, as on the main view.
        expect(harness.showInSplitView).toHaveBeenCalledWith("child-1");
    });
});
