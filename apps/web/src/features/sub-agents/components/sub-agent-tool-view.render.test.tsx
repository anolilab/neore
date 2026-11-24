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
        navigate: vi.fn(),
        openThreadInSplitView: vi.fn(async (_threadId: string) => "opened" as string),
        preferences: { splitViewEnabled: true, subAgentOpenPlace: undefined as unknown },
        run: undefined as Record<string, unknown> | undefined,
        showWarning: vi.fn(),
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
    return {
        useUIStateStore: (selector: (state: { preferences: unknown }) => unknown) => selector({ preferences: harness.preferences }),
    };
});

vi.mock("@/features/chat/split/split-layout-store", () => {
    return {
        openThreadInSplitView: (threadId: string) => harness.openThreadInSplitView(threadId),
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
    return { showError: () => {}, showWarning: (message: unknown) => harness.showWarning(message) };
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
        harness.navigate.mockClear();
        harness.openThreadInSplitView.mockClear();
        harness.openThreadInSplitView.mockResolvedValue("opened");
        harness.showWarning.mockClear();
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: undefined };
    });

    it("opens the side panel on a click by default, when the split view is on", async () => {
        const { link } = renderRunningCard();

        // The click is taken by the card, so the browser does not follow the link.
        expect(fireEvent.click(link)).toBe(false);

        expect(harness.openThreadInSplitView).toHaveBeenCalledWith("child-1");
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("opens the main view by default when the split view is off, since there is no side panel", () => {
        harness.preferences = { splitViewEnabled: false, subAgentOpenPlace: undefined };
        const { link } = renderRunningCard();

        fireEvent.click(link);

        expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        expect(harness.openThreadInSplitView).not.toHaveBeenCalled();
    });

    it("reads a browser that saved no value for the setting as the default", () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: undefined };
        const { link } = renderRunningCard();

        fireEvent.click(link);

        expect(harness.openThreadInSplitView).toHaveBeenCalledWith("child-1");
    });

    it("opens the main view on a click once the setting is the main view", () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        const { link } = renderRunningCard();

        fireEvent.click(link);

        expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        expect(harness.openThreadInSplitView).not.toHaveBeenCalled();
    });

    it("takes the main view with Ctrl or Cmd when the side panel is the setting", () => {
        const { link } = renderRunningCard();

        fireEvent.click(link, { ctrlKey: true });
        fireEvent.click(link, { metaKey: true });

        expect(harness.navigate).toHaveBeenCalledTimes(2);
        expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        expect(harness.openThreadInSplitView).not.toHaveBeenCalled();
    });

    it("takes the side panel with Ctrl or Cmd when the main view is the setting", () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        const { link } = renderRunningCard();

        fireEvent.click(link, { ctrlKey: true });
        fireEvent.click(link, { metaKey: true });

        expect(harness.openThreadInSplitView).toHaveBeenCalledTimes(2);
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("takes the main view with the middle button when the side panel is the setting, and stops the browser's new tab", () => {
        const { link } = renderRunningCard();

        expect(auxClick(link, 1)).toBe(false);

        expect(harness.navigate).toHaveBeenCalledWith(MAIN_VIEW);
        expect(harness.openThreadInSplitView).not.toHaveBeenCalled();
    });

    it("takes the side panel with the middle button when the main view is the setting", () => {
        harness.preferences = { splitViewEnabled: true, subAgentOpenPlace: "main" };
        const { link } = renderRunningCard();

        expect(auxClick(link, 1)).toBe(false);

        expect(harness.openThreadInSplitView).toHaveBeenCalledWith("child-1");
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("leaves the other mouse buttons to the browser, so a right click still opens its menu", () => {
        const { link } = renderRunningCard();

        expect(auxClick(link, 2)).toBe(true);

        expect(harness.navigate).not.toHaveBeenCalled();
        expect(harness.openThreadInSplitView).not.toHaveBeenCalled();
    });

    it("warns when every pane is taken, and opens nothing", async () => {
        harness.openThreadInSplitView.mockResolvedValue("full");
        const { link } = renderRunningCard();

        fireEvent.click(link);
        await vi.waitFor(() => {
            expect(harness.showWarning).toHaveBeenCalledWith("Split view is full. Close a chat first.");
        });

        expect(harness.navigate).not.toHaveBeenCalled();
    });
});
