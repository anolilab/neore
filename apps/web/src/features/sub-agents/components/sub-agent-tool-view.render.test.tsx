/**
 * The card of a `delegateToSubAgent` call: a sub-agent waiting on its owner's approval says so, shows no spinner, and
 * links the thread where the owner answers.
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

const { default: SubAgentToolView } = await import("./sub-agent-tool-view");

const part = { input: { task: "Delete the old files" }, state: "output-available", toolCallId: "call-1" } as never;

describe("a sub-agent's card", () => {
    it("says a waiting sub-agent needs the owner's approval, with no spinner and a link to answer it", () => {
        harness.run = { _id: "run-1", childThreadId: "child-1", error: null, status: "awaiting", task: "Delete the old files" };

        render(createElement(SubAgentToolView, { part }));

        expect(screen.getByRole("status").textContent).toBe("Waiting for your approval");
        expect(screen.queryByTestId("sub-agent-spinner")).toBeNull();
        expect(screen.getByRole("link", { name: "Open the sub-agent's thread" }).getAttribute("href")).toBe("/chat/child-1");
    });

    it("shows a working sub-agent as working, with its spinner", () => {
        harness.run = { _id: "run-1", childThreadId: "child-1", error: null, status: "running", task: "Delete the old files" };

        render(createElement(SubAgentToolView, { part }));

        expect(screen.getByRole("status").textContent).toBe("Working");
        expect(screen.getByTestId("sub-agent-spinner")).toBeTruthy();
    });
});
