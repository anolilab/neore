/**
 * The card of a `delegateToSubAgent` call: a sub-agent waiting on its owner's approval says so, shows no spinner, and
 * shows its requests (answered on the child's thread) with a link to that thread.
 */
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { run: undefined as Record<string, unknown> | undefined };
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
        Link: ({ children, params }: { children: unknown; params: { threadId: string } }) =>
            createElement("a", { href: `/chat/${params.threadId}` }, children as never),
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
